export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export const RUNNER_TYPES = {
  DIRECT: "direct",
  PLANNER_EXECUTOR_VERIFIER: "planner-executor-verifier",
  STATE_GRAPH: "state-graph",
  MULTI_AGENT: "multi-agent",
  BACKGROUND: "background",
  TRANSACTIONAL: "transactional"
} as const;

export type RunnerType = (typeof RUNNER_TYPES)[keyof typeof RUNNER_TYPES];

export const TASK_STATUSES = {
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;

export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export interface TaskProfile {
  taskId: string;
  goal: string;
  runnerType: RunnerType;
  metadata?: JsonObject;
}

export interface TaskFailure {
  code: string;
  message: string;
  retryable?: boolean;
  details?: JsonObject;
}

export type VerificationStatus = "passed" | "failed" | "inconclusive";

export interface VerificationCheck {
  name: string;
  status: VerificationStatus;
  message?: string;
  evidence?: JsonObject;
}

export interface VerificationResult {
  verificationId: string;
  status: VerificationStatus;
  summary: string;
  checks: readonly VerificationCheck[];
  evidence?: readonly JsonObject[];
  verifiedAt: string;
}

export interface ToolCall {
  callId: string;
  toolName: string;
  input: JsonObject;
  status: "requested" | "succeeded" | "failed" | "timed_out" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  output?: JsonValue;
  error?: TaskFailure;
}

export interface TaskStateSnapshot {
  taskId: string;
  status: TaskStatus;
  profile: TaskProfile;
  completedSteps: readonly string[];
  toolCalls: readonly ToolCall[];
  currentStep?: string;
  lastEventSequence: number;
  lastCheckpointId?: string;
  verification?: VerificationResult;
  error?: TaskFailure;
}

export type TaskState = TaskStateSnapshot;

export interface Checkpoint {
  checkpointId: string;
  taskId: string;
  eventSequence: number;
  createdAt: string;
  state: TaskStateSnapshot;
  metadata?: JsonObject;
}

export const RUNTIME_EVENT_TYPES = {
  TASK_CREATED: "task.created",
  TASK_STARTED: "task.started",
  TASK_PAUSED: "task.paused",
  TASK_RESUMED: "task.resumed",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TASK_CANCELLED: "task.cancelled",
  TASK_STEP_COMPLETED: "task.step_completed",
  USER_MESSAGE: "user.message",
  CHECKPOINT_CREATED: "checkpoint.created",
  CHECKPOINT_RESTORED: "checkpoint.restored",
  VERIFICATION_RECORDED: "verification.recorded",
  SESSION_STARTED: "session.started",
  SESSION_ENDED: "session.ended",
  MODEL_REQUESTED: "model.requested",
  MODEL_DELTA: "model.delta",
  MODEL_COMPLETED: "model.completed",
  MODEL_FAILED: "model.failed",
  TOOL_REQUESTED: "tool.requested",
  TOOL_COMPLETED: "tool.completed",
  TOOL_FAILED: "tool.failed",
  TOOL_TIMED_OUT: "tool.timed_out",
  TOOL_CANCELLED: "tool.cancelled",
  ROUTE_DECIDED: "route.decided",
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_RESOLVED: "approval.resolved",
  RETRY_SCHEDULED: "retry.scheduled",
  COMPENSATION_EXECUTED: "compensation.executed",
  RECOVERY_STARTED: "recovery.started",
  DECISION_EVALUATED: "decision.evaluated",
  MEMORY_UPDATED: "memory.updated",
  CONTEXT_COMPRESSED: "context.compressed"
} as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];

export interface TaskCreatedPayload {
  profile: TaskProfile;
}

export interface TaskStartedPayload {
  reason?: string;
}

export interface TaskPausedPayload {
  reason?: string;
}

export interface TaskResumedPayload {
  reason?: string;
}

export interface TaskCompletedPayload {
  summary?: string;
  completedSteps?: readonly string[];
}

export interface TaskFailedPayload {
  error: TaskFailure;
}

export interface TaskCancelledPayload {
  reason?: string;
}

/** One image attached to a user turn, as base64 so the ledger stays self-contained. */
export interface UserImage {
  mediaType: string;
  data: string;
}

/** A turn the user typed into a conversation, optionally with images. */
export interface UserMessagePayload {
  text: string;
  images?: readonly UserImage[];
}

export interface TaskStepCompletedPayload {
  step: string;
  index: number;
}

export interface CheckpointCreatedPayload {
  checkpoint: Checkpoint;
}

export interface CheckpointRestoredPayload {
  checkpointId: string;
  state: TaskStateSnapshot;
}

export interface VerificationRecordedPayload {
  result: VerificationResult;
}

export interface SessionStartedPayload {
  sessionId: string;
}

export interface SessionEndedPayload {
  sessionId: string;
  status: "completed" | "failed" | "cancelled" | "paused";
}

export interface ModelRequestedPayload {
  sessionId: string;
  requestId: string;
  provider: string;
  model: string;
  turn: number;
  messageCount: number;
}

export interface ModelDeltaPayload {
  sessionId: string;
  requestId: string;
  text: string;
}

export interface ModelUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelCompletedPayload {
  sessionId: string;
  requestId: string;
  text: string;
  finishReason: "stop" | "tool_call" | "length";
  usage?: ModelUsage;
  costUsd?: number;
}

export interface ModelFailedPayload {
  sessionId: string;
  requestId: string;
  error: TaskFailure;
}

export interface ToolRequestedPayload {
  sessionId: string;
  call: ToolCall;
}

export interface ToolCompletedPayload {
  sessionId: string;
  callId: string;
  output: JsonValue;
  completedAt: string;
  durationMs: number;
}

export interface ToolFailedPayload {
  sessionId: string;
  callId: string;
  error: TaskFailure;
  completedAt: string;
  durationMs: number;
}

export interface ToolTimedOutPayload {
  sessionId: string;
  callId: string;
  timeoutMs: number;
  completedAt: string;
  durationMs: number;
}

export interface ToolCancelledPayload {
  sessionId: string;
  callId: string;
  reason: string;
  completedAt: string;
  durationMs: number;
}

export interface RouteDecidedPayload {
  runnerType: RunnerType;
  reason: string;
  evidence: JsonObject;
  confidence?: number;
  upgradedFrom?: RunnerType;
}

export type ApprovalDecision = "approved" | "rejected" | "expired";

export interface ApprovalRequestedPayload {
  approvalId: string;
  toolName: string;
  risk: "low" | "medium" | "high" | "critical";
  reason: string;
}

export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  actor: string;
  reason?: string;
}

export interface RetryScheduledPayload {
  operation: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
}

export interface CompensationExecutedPayload {
  compensationId: string;
  action: string;
  status: "succeeded" | "failed";
  error?: TaskFailure;
}

export interface RecoveryStartedPayload {
  checkpointId?: string;
  reason: string;
}

export interface DecisionEvaluatedPayload {
  decisionId: string;
  provider: string;
  kind: "tool" | "stop" | "escalate" | "approval" | "runner";
  choice: string;
  confidence: number;
  latencyMs: number;
  authoritative: boolean;
  fallback?: boolean;
  reason: string;
}

export interface MemoryUpdatedPayload {
  memoryId: string;
  scope: "global" | "project" | "task" | "session";
  action: "created" | "updated" | "deleted" | "restored" | "conflict";
  version: number;
}

export interface ContextCompressedPayload {
  compressionId: string;
  beforeTokens: number;
  afterTokens: number;
  reductionRatio: number;
  qualityPassed: boolean;
  preservedConstraints: readonly string[];
}

export interface RuntimeEventBase<T extends RuntimeEventType, P> {
  eventId: string;
  taskId: string;
  sequence: number;
  occurredAt: string;
  type: T;
  payload: P;
}

export interface RuntimeEventByType {
  "task.created": RuntimeEventBase<"task.created", TaskCreatedPayload>;
  "task.started": RuntimeEventBase<"task.started", TaskStartedPayload>;
  "task.paused": RuntimeEventBase<"task.paused", TaskPausedPayload>;
  "task.resumed": RuntimeEventBase<"task.resumed", TaskResumedPayload>;
  "task.completed": RuntimeEventBase<"task.completed", TaskCompletedPayload>;
  "task.failed": RuntimeEventBase<"task.failed", TaskFailedPayload>;
  "task.cancelled": RuntimeEventBase<"task.cancelled", TaskCancelledPayload>;
  "task.step_completed": RuntimeEventBase<"task.step_completed", TaskStepCompletedPayload>;
  "user.message": RuntimeEventBase<"user.message", UserMessagePayload>;
  "checkpoint.created": RuntimeEventBase<"checkpoint.created", CheckpointCreatedPayload>;
  "checkpoint.restored": RuntimeEventBase<"checkpoint.restored", CheckpointRestoredPayload>;
  "verification.recorded": RuntimeEventBase<"verification.recorded", VerificationRecordedPayload>;
  "session.started": RuntimeEventBase<"session.started", SessionStartedPayload>;
  "session.ended": RuntimeEventBase<"session.ended", SessionEndedPayload>;
  "model.requested": RuntimeEventBase<"model.requested", ModelRequestedPayload>;
  "model.delta": RuntimeEventBase<"model.delta", ModelDeltaPayload>;
  "model.completed": RuntimeEventBase<"model.completed", ModelCompletedPayload>;
  "model.failed": RuntimeEventBase<"model.failed", ModelFailedPayload>;
  "tool.requested": RuntimeEventBase<"tool.requested", ToolRequestedPayload>;
  "tool.completed": RuntimeEventBase<"tool.completed", ToolCompletedPayload>;
  "tool.failed": RuntimeEventBase<"tool.failed", ToolFailedPayload>;
  "tool.timed_out": RuntimeEventBase<"tool.timed_out", ToolTimedOutPayload>;
  "tool.cancelled": RuntimeEventBase<"tool.cancelled", ToolCancelledPayload>;
  "route.decided": RuntimeEventBase<"route.decided", RouteDecidedPayload>;
  "approval.requested": RuntimeEventBase<"approval.requested", ApprovalRequestedPayload>;
  "approval.resolved": RuntimeEventBase<"approval.resolved", ApprovalResolvedPayload>;
  "retry.scheduled": RuntimeEventBase<"retry.scheduled", RetryScheduledPayload>;
  "compensation.executed": RuntimeEventBase<"compensation.executed", CompensationExecutedPayload>;
  "recovery.started": RuntimeEventBase<"recovery.started", RecoveryStartedPayload>;
  "decision.evaluated": RuntimeEventBase<"decision.evaluated", DecisionEvaluatedPayload>;
  "memory.updated": RuntimeEventBase<"memory.updated", MemoryUpdatedPayload>;
  "context.compressed": RuntimeEventBase<"context.compressed", ContextCompressedPayload>;
}

export type RuntimeEvent<T extends RuntimeEventType = RuntimeEventType> = {
  [K in T]: RuntimeEventByType[K];
}[T];

export type RuntimeEventInput<T extends RuntimeEventType = RuntimeEventType> = {
  [K in T]: Omit<RuntimeEventByType[K], "sequence" | "occurredAt"> & {
    occurredAt?: string;
  };
}[T];

export interface Runner {
  run(taskId: string): AsyncIterable<RuntimeEvent>;
  pause(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  rollback(taskId: string): Promise<void>;
}
