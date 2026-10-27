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
  status: "requested" | "succeeded" | "failed" | "cancelled";
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
  CHECKPOINT_CREATED: "checkpoint.created",
  CHECKPOINT_RESTORED: "checkpoint.restored",
  VERIFICATION_RECORDED: "verification.recorded"
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
  "checkpoint.created": RuntimeEventBase<"checkpoint.created", CheckpointCreatedPayload>;
  "checkpoint.restored": RuntimeEventBase<"checkpoint.restored", CheckpointRestoredPayload>;
  "verification.recorded": RuntimeEventBase<"verification.recorded", VerificationRecordedPayload>;
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
