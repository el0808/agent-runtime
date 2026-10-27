import { randomUUID } from "node:crypto";
import { ERROR_CODES, RUNTIME_EVENT_TYPES, RuntimeError } from "@agent/protocol";
import type { JsonObject, RuntimeEvent, TaskFailure } from "@agent/protocol";
import type { TaskLedger } from "@agent/task-ledger";

export type DecisionKind = "tool" | "stop" | "escalate" | "approval" | "runner";
export type DecisionRisk = "low" | "medium" | "high" | "critical";

export interface DecisionContext {
  readonly taskId: string;
  readonly goal: string;
  readonly kind: DecisionKind;
  readonly options: readonly string[];
  readonly risk: DecisionRisk;
  readonly failureCount: number;
  readonly metadata?: JsonObject;
}

export interface DecisionResult {
  readonly provider: string;
  readonly choice: string;
  readonly confidence: number;
  readonly reason: string;
  readonly latencyMs: number;
  readonly fallback?: boolean;
}

export interface DecisionProvider {
  readonly name: string;
  decide(context: DecisionContext, signal?: AbortSignal): Promise<DecisionResult>;
}

function choiceFromOptions(options: readonly string[], preferred: string): string {
  return options.includes(preferred) ? preferred : options[0] ?? preferred;
}

export class RulesDecisionProvider implements DecisionProvider {
  readonly name = "rules";

  async decide(context: DecisionContext): Promise<DecisionResult> {
    const started = Date.now();
    let preferred: string;
    let reason: string;
    if (context.kind === "approval") {
      preferred = context.risk === "critical" || context.risk === "high" ? "review" : context.risk === "medium" ? "approval" : "allow";
      reason = context.risk === "high" || context.risk === "critical" ? "high-risk approval is deterministic" : "risk policy";
    } else if (context.kind === "escalate") {
      preferred = context.failureCount >= 2 ? "strong" : "fast";
      reason = context.failureCount >= 2 ? "repeated failures" : "routine execution";
    } else if (context.kind === "stop") {
      preferred = context.failureCount >= 3 ? "stop" : "continue";
      reason = context.failureCount >= 3 ? "failure limit reached" : "continue while retryable";
    } else {
      preferred = context.options[0] ?? "continue";
      reason = context.kind === "runner" ? "deterministic runner rule" : "first safe option";
    }
    return { provider: this.name, choice: choiceFromOptions(context.options, preferred), confidence: 1, reason, latencyMs: Date.now() - started };
  }
}

export interface JevResponse {
  readonly choice: string;
  readonly confidence: number;
  readonly reason?: string;
}

export type JevTransport = (context: DecisionContext, signal: AbortSignal) => Promise<JevResponse>;

export interface JevDecisionProviderOptions {
  readonly transport: JevTransport;
  readonly timeoutMs?: number;
}

export class JevDecisionProvider implements DecisionProvider {
  readonly name = "jev";
  private readonly transport: JevTransport;
  private readonly timeoutMs: number;

  constructor(options: JevDecisionProviderOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 150;
  }

  async decide(context: DecisionContext, signal?: AbortSignal): Promise<DecisionResult> {
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("jev timeout"));
        reject(new Error("jev timeout"));
      }, this.timeoutMs);
    });
    let rejectExternal: ((reason: unknown) => void) | undefined;
    const aborted = signal === undefined ? undefined : new Promise<never>((_, reject) => { rejectExternal = reject; });
    const onExternalAbort = () => {
      controller.abort(signal?.reason);
      rejectExternal?.(signal?.reason ?? new Error("cancelled"));
    };
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    try {
      const response = await Promise.race([this.transport(context, controller.signal), timeout, ...(aborted === undefined ? [] : [aborted])]);
      if (!Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 1) {
        throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "Jev confidence must be between 0 and 1" });
      }
      return { provider: this.name, choice: response.choice, confidence: response.confidence, reason: response.reason ?? "Jev decision", latencyMs: Date.now() - started };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new RuntimeError({ code: ERROR_CODES.DEPENDENCY_UNAVAILABLE, message: `Jev unavailable: ${reason}`, details: { latencyMs: Date.now() - started } });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

export interface DecisionRouterOptions {
  readonly ledger: TaskLedger;
  readonly rules?: DecisionProvider;
  readonly jev?: DecisionProvider;
  readonly strong?: DecisionProvider;
  readonly confidenceThreshold?: number;
  readonly shadowMode?: boolean;
}

export class DecisionRouter {
  private readonly ledger: TaskLedger;
  private readonly rules: DecisionProvider;
  private readonly jev: DecisionProvider | undefined;
  private readonly strong: DecisionProvider;
  private readonly threshold: number;
  private readonly shadowMode: boolean;

  constructor(options: DecisionRouterOptions) {
    this.ledger = options.ledger;
    this.rules = options.rules ?? new RulesDecisionProvider();
    this.jev = options.jev;
    this.strong = options.strong ?? this.rules;
    this.threshold = options.confidenceThreshold ?? 0.75;
    this.shadowMode = options.shadowMode ?? false;
    if (this.threshold < 0 || this.threshold > 1) throw new RuntimeError({ code: ERROR_CODES.INVALID_INPUT, message: "confidenceThreshold must be between 0 and 1" });
  }

  async decide(context: DecisionContext): Promise<DecisionResult> {
    const ruleResult = await this.rules.decide(context);
    if (this.shadowMode && this.jev !== undefined) {
      try {
        const shadow = await this.jev.decide(context);
        this.appendEvent(context.taskId, context.kind, shadow, false);
      } catch {
        // Shadow mode never changes the authoritative rule result.
      }
      this.appendEvent(context.taskId, context.kind, ruleResult, true);
      return ruleResult;
    }

    let selected = ruleResult;
    if (this.jev !== undefined && !(context.kind === "approval" && (context.risk === "high" || context.risk === "critical"))) {
      try {
        const jev = await this.jev.decide(context);
        if (jev.confidence >= this.threshold && context.options.includes(jev.choice)) {
          selected = jev;
        } else {
          selected = { ...(await this.strong.decide(context)), fallback: true };
        }
      } catch {
        selected = { ...(await this.strong.decide(context)), fallback: true };
      }
    }
    if (context.kind === "approval" && (context.risk === "high" || context.risk === "critical")) {
      selected = ruleResult;
    }
    this.appendEvent(context.taskId, context.kind, selected, true);
    return selected;
  }

  private appendEvent(taskId: string, kind: DecisionKind, result: DecisionResult, authoritative: boolean): RuntimeEvent {
    return this.ledger.appendEvent({
      eventId: randomUUID(), taskId, type: RUNTIME_EVENT_TYPES.DECISION_EVALUATED,
      payload: {
        decisionId: randomUUID(), provider: result.provider, kind, choice: result.choice,
        confidence: result.confidence, latencyMs: result.latencyMs, authoritative,
        ...(result.fallback === true ? { fallback: true } : {}), reason: result.reason
      }
    }).event;
  }
}

export function decisionFailure(error: unknown): TaskFailure {
  return error instanceof RuntimeError ? { code: error.code, message: error.message } : { code: ERROR_CODES.INTERNAL, message: error instanceof Error ? error.message : String(error) };
}
