import { randomUUID } from "node:crypto";
import { RUNTIME_EVENT_TYPES, ERROR_CODES } from "@agent/protocol";
import type { JsonObject, TaskFailure, ToolCall } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";
import type { ToolExecutionOptions, ToolExecutionResult, ToolRegistry } from "@agent/tools";

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
}

export function classifyCommandRisk(command: string): RiskLevel {
  const normalized = command.toLowerCase();
  if (/\b(rm|rmdir|del|drop database|truncate|delete from)\b/u.test(normalized)) return "critical";
  if (/\b(deploy|publish|migrate|terraform apply|kubectl delete|send|payment)\b/u.test(normalized)) return "high";
  if (/\b(write|move|rename|chmod|git push)\b/u.test(normalized)) return "medium";
  return "low";
}

export class ToolPermissionPolicy {
  private readonly deniedTools: ReadonlySet<string>;
  private readonly autoApproveMedium: boolean;

  constructor(options: PolicyOptions = {}) {
    this.deniedTools = new Set(options.deniedTools ?? []);
    this.autoApproveMedium = options.autoApproveMedium ?? false;
  }

  evaluate(toolName: string, input: JsonObject): PermissionDecision {
    if (this.deniedTools.has(toolName)) return { outcome: "deny", risk: "critical", reason: `Tool ${toolName} is denied by policy` };
    const command = typeof input.command === "string" ? input.command : "";
    const risk = toolName === "read_file" || toolName === "run_tests" ? "low" : toolName === "write_file" ? "medium" : command.length > 0 ? classifyCommandRisk(command) : "high";
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
    this.decisions.set(approvalId, decision);
    ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED,
      payload: { approvalId, decision, actor, ...(reason === undefined ? {} : { reason }) }
    });
  }

  isApproved(approvalId: string): boolean { return this.decisions.get(approvalId) === "approved"; }
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
    private readonly ledger: TaskLedger
  ) {}

  async execute(taskId: string, call: ToolCall, options: GuardedExecutionOptions = {}): Promise<ToolExecutionResult> {
    const decision = this.policy.evaluate(call.toolName, call.input);
    if (decision.outcome === "deny") {
      const error: TaskFailure = { code: ERROR_CODES.PERMISSION_DENIED, message: decision.reason };
      return { status: "failed", error, completedAt: new Date().toISOString(), durationMs: 0 };
    }
    if (decision.outcome === "approval_required" && (options.approvalId === undefined || !this.approvals.isApproved(options.approvalId))) {
      const approvalId = this.approvals.request(taskId, call.toolName, decision, this.ledger);
      return { status: "failed", error: { code: ERROR_CODES.PERMISSION_DENIED, message: `Approval required: ${approvalId}`, details: { approvalId } as JsonObject }, completedAt: new Date().toISOString(), durationMs: 0 };
    }
    if (decision.risk === "medium" || decision.risk === "high") {
      this.ledger.createCheckpoint(taskId, { reason: "before-external-side-effect", toolName: call.toolName });
    }
    return this.registry.execute(call.toolName, call.input, options);
  }
}
