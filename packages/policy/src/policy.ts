import { randomUUID } from "node:crypto";
import { RUNTIME_EVENT_TYPES, ERROR_CODES, RuntimeError } from "@agent/protocol";
import type { JsonObject, TaskFailure, ToolCall } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ToolExecutionOptions, ToolExecutionResult, ToolRegistry } from "@agent/tools";
import type { CompensationAction, CompensationRegistry } from "./recovery.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PermissionOutcome = "allow" | "approval_required" | "deny";

export interface PermissionDecision {
  readonly outcome: PermissionOutcome;
  readonly risk: RiskLevel;
  readonly reason: string;
}

export interface PolicyOptions {
  readonly deniedTools?: readonly string[];
  readonly autoApproveMedium?: boolean;
  /** Extra tools that only observe state, merged with {@link READ_ONLY_TOOLS}. */
  readonly readOnlyTools?: readonly string[];
  /** Extra tools that change the workspace, merged with {@link WRITE_TOOLS}. */
  readonly writeTools?: readonly string[];
  /** Extra tools with no effect outside agent storage, merged with {@link SAFE_LOCAL_TOOLS}. */
  readonly safeLocalTools?: readonly string[];
  /** Per-tool risk, for tools whose risk cannot be inferred from the name. */
  readonly riskOverrides?: Readonly<Record<string, RiskLevel>>;
}

export function classifyCommandRisk(command: string): RiskLevel {
  const normalized = command.toLowerCase();
  if (/\b(rm|rmdir|del|drop database|truncate|delete from)\b/u.test(normalized)) return "critical";
  if (/\b(deploy|publish|migrate|terraform apply|kubectl delete|send|payment)\b/u.test(normalized)) return "high";
  if (/\b(write|move|rename|chmod|git push)\b/u.test(normalized)) return "medium";
  return "low";
}

/** Well-known tools that only observe state, so they never need approval. */
export const READ_ONLY_TOOLS: readonly string[] = ["read_file", "list_dir", "search_files", "glob", "grep"];

/** Tools that change the workspace but are reversible through a checkpoint. */
export const WRITE_TOOLS: readonly string[] = ["write_file", "edit_file", "apply_patch"];

/**
 * Tools with no effect outside the agent's own storage. They are not read-only,
 * but asking a human to approve saving a memory would make the tool useless.
 */
export const SAFE_LOCAL_TOOLS: readonly string[] = ["remember", "todo_write", "notebook"];

export class ToolPermissionPolicy {
  private readonly deniedTools: ReadonlySet<string>;
  private readonly autoApproveMedium: boolean;
  private readonly readOnly: ReadonlySet<string>;
  private readonly writable: ReadonlySet<string>;
  private readonly local: ReadonlySet<string>;
  private readonly overrides: Readonly<Record<string, RiskLevel>>;

  constructor(options: PolicyOptions = {}) {
    this.deniedTools = new Set(options.deniedTools ?? []);
    this.autoApproveMedium = options.autoApproveMedium ?? false;
    this.readOnly = new Set([...READ_ONLY_TOOLS, ...(options.readOnlyTools ?? [])]);
    this.writable = new Set([...WRITE_TOOLS, ...(options.writeTools ?? [])]);
    this.local = new Set([...SAFE_LOCAL_TOOLS, ...(options.safeLocalTools ?? [])]);
    this.overrides = options.riskOverrides ?? {};
  }

  /** Explicit override wins, then the read-only set, then the tool's command. */
  private riskOf(toolName: string, command: string): RiskLevel {
    const override = this.overrides[toolName];
    if (override !== undefined) return override;
    if (this.readOnly.has(toolName)) return "low";
    if (this.local.has(toolName)) return "low";
    if (this.writable.has(toolName)) return "medium";
    if (toolName === "run_tests") return "low";
    if (command.length > 0) return classifyCommandRisk(command);
    // An unknown tool that takes no command is treated as risky on purpose:
    // new tools must be classified explicitly rather than defaulting to allow.
    return "high";
  }

  evaluate(toolName: string, input: JsonObject): PermissionDecision {
    if (this.deniedTools.has(toolName)) return { outcome: "deny", risk: "critical", reason: `Tool ${toolName} is denied by policy` };
    const command = typeof input.command === "string" ? input.command : "";
    const risk = this.riskOf(toolName, command);
    if (risk === "critical") return { outcome: "deny", risk, reason: "Critical destructive operations are blocked by deterministic policy" };
    if (risk === "high" || (risk === "medium" && !this.autoApproveMedium)) return { outcome: "approval_required", risk, reason: "Operation requires an explicit human approval" };
    return { outcome: "allow", risk, reason: "Operation is allowed by deterministic policy" };
  }
}

export class ApprovalManager {
  private readonly decisions = new Map<string, "approved" | "rejected" | "expired">();

  request(taskId: string, toolName: string, decision: PermissionDecision, ledger: TaskLedger): string {
    const approvalId = randomUUID();
    ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED,
      payload: { approvalId, toolName, risk: decision.risk, reason: decision.reason }
    });
    return approvalId;
  }

  resolve(taskId: string, approvalId: string, decision: "approved" | "rejected" | "expired", actor: string, ledger: TaskLedger, reason?: string): void {
    // Appending for an id the task never asked for writes an event the state
    // machine cannot replay, which corrupts the task permanently.
    if (!this.pending(taskId, ledger).includes(approvalId)) {
      throw new RuntimeError({
        code: ERROR_CODES.NOT_FOUND,
        message: `Approval ${approvalId} is not pending for task ${taskId}`,
        details: { taskId, approvalId }
      });
    }
    this.decisions.set(approvalId, decision);
    ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED,
      payload: { approvalId, decision, actor, ...(reason === undefined ? {} : { reason }) }
    });
  }

  /**
   * Checks memory first, then replays the task's approval events so decisions
   * survive a process restart.
   */
  isApproved(approvalId: string, taskId?: string, ledger?: TaskLedger): boolean {
    const cached = this.decisions.get(approvalId);
    if (cached !== undefined) {
      return cached === "approved";
    }
    if (taskId === undefined || ledger === undefined) {
      return false;
    }
    for (const event of ledger.getEvents(taskId)) {
      if (event.type === RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED && event.payload.approvalId === approvalId) {
        return event.payload.decision === "approved";
      }
    }
    return false;
  }

  pending(taskId: string, ledger: TaskLedger): string[] {
    const requested = new Map<string, string>();
    const resolved = new Set<string>();
    for (const event of ledger.getEvents(taskId)) {
      if (event.type === RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED) requested.set(event.payload.approvalId, event.payload.toolName);
      if (event.type === RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED) resolved.add(event.payload.approvalId);
    }
    return [...requested.entries()]
      .filter(([approvalId]) => !resolved.has(approvalId))
      .map(([approvalId]) => approvalId);
  }

  /**
   * Tools the user already approved for this task. Derived from the event log so
   * the grant survives a restart and a rerun does not re-prompt.
   */
  approvedTools(taskId: string, ledger: TaskLedger): Set<string> {
    const toolNameByApproval = new Map<string, string>();
    const approved = new Set<string>();
    for (const event of ledger.getEvents(taskId)) {
      if (event.type === RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED) {
        toolNameByApproval.set(event.payload.approvalId, event.payload.toolName);
      }
      if (event.type === RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED && event.payload.decision === "approved") {
        const toolName = toolNameByApproval.get(event.payload.approvalId);
        if (toolName !== undefined) approved.add(toolName);
      }
    }
    return approved;
  }
}

/**
 * Adapts {@link GuardedToolExecutor} to the `ToolExecutor` shape the ReAct runner expects,
 * reading `taskId` and `approvalId` from tool metadata.
 */
export class PolicyToolExecutor {
  constructor(private readonly guarded: GuardedToolExecutor) {}

  execute(toolName: string, input: JsonObject, options: ToolExecutionOptions = {}): Promise<ToolExecutionResult> {
    const taskId = options.metadata?.taskId;
    if (typeof taskId !== "string") {
      throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "PolicyToolExecutor requires metadata.taskId" });
    }
    const approvalId = options.metadata?.approvalId;
    const call: ToolCall = {
      callId: typeof options.metadata?.callId === "string" ? options.metadata.callId : randomUUID(),
      toolName,
      input,
      status: "requested"
    };
    return this.guarded.execute(taskId, call, {
      ...options,
      ...(typeof approvalId === "string" ? { approvalId } : {})
    });
  }
}

export interface GuardedExecutionOptions extends ToolExecutionOptions {
  readonly approvalId?: string;
  readonly actor?: string;
}

export class GuardedToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly policy: ToolPermissionPolicy,
    private readonly approvals: ApprovalManager,
    private readonly ledger: TaskLedger,
    /** When present, file writes register an undo so rollback can restore them. */
    private readonly compensations?: CompensationRegistry
  ) {}

  async execute(taskId: string, call: ToolCall, options: GuardedExecutionOptions = {}): Promise<ToolExecutionResult> {
    const decision = this.policy.evaluate(call.toolName, call.input);
    if (decision.outcome === "deny") {
      const error: TaskFailure = { code: ERROR_CODES.PERMISSION_DENIED, message: decision.reason };
      return { status: "failed", error, completedAt: new Date().toISOString(), durationMs: 0 };
    }
    const alreadyGranted = this.approvals.approvedTools(taskId, this.ledger).has(call.toolName);
    if (decision.outcome === "approval_required" && !alreadyGranted && (options.approvalId === undefined || !this.approvals.isApproved(options.approvalId, taskId, this.ledger))) {
      const approvalId = this.approvals.request(taskId, call.toolName, decision, this.ledger);
      return { status: "failed", error: { code: ERROR_CODES.PERMISSION_DENIED, message: `Approval required: ${approvalId}`, details: { approvalId } as JsonObject }, completedAt: new Date().toISOString(), durationMs: 0 };
    }
    if (decision.risk === "medium" || decision.risk === "high") {
      this.ledger.createCheckpoint(taskId, { reason: "before-external-side-effect", toolName: call.toolName });
    }
    // A checkpoint restores the task's state, not the disk. Recording the prior
    // file contents is what lets rollback undo a write that really happened.
    const undo = this.compensations === undefined ? undefined : await this.captureUndo(taskId, call, options);
    const result = await this.registry.execute(call.toolName, call.input, options);
    if (undo !== undefined && result.status === "succeeded") {
      this.compensations?.register(undo);
    }
    return result;
  }

  /** Snapshots a file before it is overwritten, so rollback can put it back. */
  private async captureUndo(
    taskId: string,
    call: ToolCall,
    options: GuardedExecutionOptions
  ): Promise<CompensationAction | undefined> {
    if (call.toolName !== "write_file" && call.toolName !== "edit_file") {
      return undefined;
    }
    const relative = typeof call.input.path === "string" ? call.input.path : "";
    if (relative === "" || options.workspaceRoot === undefined) {
      return undefined;
    }
    const { readFile, writeFile, unlink } = await import("node:fs/promises");
    const path = await import("node:path");
    const target = path.resolve(options.workspaceRoot, relative);
    const before = await readFile(target, "utf8").catch(() => null);
    return {
      compensationId: randomUUID(),
      name: `restore ${relative}`,
      taskId,
      execute: async () => {
        if (before === null) {
          await unlink(target).catch(() => undefined);
        } else {
          await writeFile(target, before, "utf8");
        }
      }
    };
  }
}
