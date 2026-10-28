import {
  ERROR_CODES,
  RUNTIME_EVENT_TYPES,
  TASK_STATUSES,
  RuntimeError
} from "@agent/protocol";
import type {
  RuntimeEvent,
  TaskState,
  TaskStatus,
  TaskProfile,
  ToolCall
} from "@agent/protocol";

function invalidTransition(taskId: string, status: TaskStatus, eventType: string): never {
  throw new RuntimeError({
    code: ERROR_CODES.INVALID_STATE_TRANSITION,
    message: `Cannot apply ${eventType} while task is ${status}`,
    details: { taskId, status, eventType }
  });
}

function requireTaskId(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: "Event task id does not match task state",
      details: { expected, actual }
    });
  }
}

function requireNextSequence(state: TaskState, event: RuntimeEvent): void {
  if (event.sequence !== state.lastEventSequence + 1) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: "Event sequence is not contiguous",
      details: {
        taskId: state.taskId,
        expectedSequence: state.lastEventSequence + 1,
        actualSequence: event.sequence
      }
    });
  }
}

function baseNextState(state: TaskState, event: RuntimeEvent): TaskState {
  requireTaskId(state.taskId, event.taskId);
  requireNextSequence(state, event);
  return { ...state, lastEventSequence: event.sequence };
}

function updateToolCall(
  state: TaskState,
  callId: string,
  update: (call: ToolCall) => ToolCall
): TaskState {
  const index = state.toolCalls.findIndex((call) => call.callId === callId);
  if (index < 0) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: `Tool call ${callId} was not found`,
      details: { taskId: state.taskId, callId }
    });
  }
  const toolCalls = [...state.toolCalls];
  const current = toolCalls[index];
  if (current === undefined) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: `Tool call ${callId} was not found`,
      details: { taskId: state.taskId, callId }
    });
  }
  toolCalls[index] = update(current);
  return { ...state, toolCalls };
}

export function createInitialTaskState(profile: TaskProfile): TaskState {
  return {
    taskId: profile.taskId,
    status: TASK_STATUSES.PENDING,
    profile,
    completedSteps: [],
    toolCalls: [],
    lastEventSequence: 0
  };
}

export function applyRuntimeEvent(
  state: TaskState | undefined,
  event: RuntimeEvent
): TaskState {
  if (state === undefined) {
    if (event.type !== RUNTIME_EVENT_TYPES.TASK_CREATED || event.sequence !== 1) {
      throw new RuntimeError({
        code: ERROR_CODES.CORRUPT_LEDGER,
        message: "The first event must be task.created with sequence 1",
        details: { taskId: event.taskId, eventType: event.type, sequence: event.sequence }
      });
    }
    if (event.payload.profile.taskId !== event.taskId) {
      throw new RuntimeError({
        code: ERROR_CODES.CORRUPT_LEDGER,
        message: "Created task profile id does not match event task id",
        details: { taskId: event.taskId, profileTaskId: event.payload.profile.taskId }
      });
    }
    return {
      ...createInitialTaskState(event.payload.profile),
      lastEventSequence: event.sequence
    };
  }

  if (event.type === RUNTIME_EVENT_TYPES.TASK_CREATED) {
    invalidTransition(state.taskId, state.status, event.type);
  }

  const next = baseNextState(state, event);

  switch (event.type) {
    case RUNTIME_EVENT_TYPES.SESSION_STARTED:
    case RUNTIME_EVENT_TYPES.SESSION_ENDED:
    case RUNTIME_EVENT_TYPES.MODEL_REQUESTED:
    case RUNTIME_EVENT_TYPES.MODEL_DELTA:
    case RUNTIME_EVENT_TYPES.MODEL_COMPLETED:
    case RUNTIME_EVENT_TYPES.MODEL_FAILED:
    case RUNTIME_EVENT_TYPES.ROUTE_DECIDED:
    case RUNTIME_EVENT_TYPES.APPROVAL_REQUESTED:
    case RUNTIME_EVENT_TYPES.APPROVAL_RESOLVED:
    case RUNTIME_EVENT_TYPES.RETRY_SCHEDULED:
    case RUNTIME_EVENT_TYPES.COMPENSATION_EXECUTED:
    case RUNTIME_EVENT_TYPES.RECOVERY_STARTED:
    case RUNTIME_EVENT_TYPES.DECISION_EVALUATED:
    case RUNTIME_EVENT_TYPES.MEMORY_UPDATED:
    case RUNTIME_EVENT_TYPES.CONTEXT_COMPRESSED:
      return next;

    case RUNTIME_EVENT_TYPES.TASK_STEP_COMPLETED: {
      if (state.status !== TASK_STATUSES.RUNNING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      const { step } = event.payload;
      return {
        ...next,
        currentStep: step,
        completedSteps: state.completedSteps.includes(step)
          ? state.completedSteps
          : [...state.completedSteps, step]
      };
    }

    case RUNTIME_EVENT_TYPES.TOOL_REQUESTED:
      if (state.status === TASK_STATUSES.COMPLETED || state.status === TASK_STATUSES.CANCELLED) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      if (state.toolCalls.some((call) => call.callId === event.payload.call.callId)) {
        throw new RuntimeError({
          code: ERROR_CODES.CORRUPT_LEDGER,
          message: `Tool call ${event.payload.call.callId} was already requested`,
          details: { taskId: state.taskId, callId: event.payload.call.callId }
        });
      }
      return { ...next, toolCalls: [...state.toolCalls, event.payload.call] };

    case RUNTIME_EVENT_TYPES.TOOL_COMPLETED:
      return updateToolCall(next, event.payload.callId, (call) => {
        const completed: ToolCall = {
          ...call,
          status: "succeeded",
          output: event.payload.output,
          completedAt: event.payload.completedAt
        };
        delete completed.error;
        return completed;
      });

    case RUNTIME_EVENT_TYPES.TOOL_FAILED:
      return updateToolCall(next, event.payload.callId, (call) => {
        const failed: ToolCall = {
          ...call,
          status: "failed",
          error: event.payload.error,
          completedAt: event.payload.completedAt
        };
        delete failed.output;
        return failed;
      });

    case RUNTIME_EVENT_TYPES.TOOL_TIMED_OUT:
      return updateToolCall(next, event.payload.callId, (call) => {
        const timedOut: ToolCall = {
          ...call,
          status: "timed_out",
          completedAt: event.payload.completedAt
        };
        delete timedOut.output;
        return timedOut;
      });

    case RUNTIME_EVENT_TYPES.TOOL_CANCELLED:
      return updateToolCall(next, event.payload.callId, (call) => {
        const cancelled: ToolCall = {
          ...call,
          status: "cancelled",
          completedAt: event.payload.completedAt
        };
        delete cancelled.output;
        return cancelled;
      });

    case RUNTIME_EVENT_TYPES.TASK_STARTED:
      if (state.status !== TASK_STATUSES.PENDING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.RUNNING };

    // A plan is recorded before any step runs, so the task is visibly planning
    // rather than reported as running with nothing happening.
    case RUNTIME_EVENT_TYPES.PLAN_CREATED: {
      // A runner may record its plan before starting (pending) or right after
      // task.started (running), so both are legitimate entry points.
      if (
        state.status !== TASK_STATUSES.PENDING &&
        state.status !== TASK_STATUSES.PLANNING &&
        state.status !== TASK_STATUSES.RUNNING
      ) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      // Already running means the plan arrived late; do not walk the status back.
      const status = state.status === TASK_STATUSES.RUNNING ? TASK_STATUSES.RUNNING : TASK_STATUSES.PLANNING;
      return { ...next, status, completedSteps: state.completedSteps };
    }

    // Waiting is a live state: the run is blocked on a human, not stopped.
    case RUNTIME_EVENT_TYPES.TASK_WAITING: {
      if (state.status !== TASK_STATUSES.RUNNING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.WAITING };
    }

    case RUNTIME_EVENT_TYPES.TASK_PAUSED:
      if (state.status !== TASK_STATUSES.RUNNING && state.status !== TASK_STATUSES.WAITING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.PAUSED };

    case RUNTIME_EVENT_TYPES.TASK_RESUMED:
      if (
        state.status !== TASK_STATUSES.PAUSED &&
        state.status !== TASK_STATUSES.WAITING &&
        state.status !== TASK_STATUSES.FAILED &&
        state.status !== TASK_STATUSES.PLANNING &&
        // A runner that records its plan while already running still calls this
        // to leave planning; treating it as already-resumed keeps it idempotent.
        state.status !== TASK_STATUSES.RUNNING
      ) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      {
        const resumed = { ...next, status: TASK_STATUSES.RUNNING };
        delete resumed.error;
        return resumed;
      }

    // Verification is its own state: a task being checked is neither running
    // nor finished, and the UI should say so.
    case RUNTIME_EVENT_TYPES.VERIFICATION_STARTED: {
      if (
        state.status !== TASK_STATUSES.RUNNING &&
        state.status !== TASK_STATUSES.PLANNING &&
        state.status !== TASK_STATUSES.COMPLETED &&
        state.status !== TASK_STATUSES.FAILED
      ) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      // Checking a finished task is the common case (the user pressed Verify),
      // so remember what to return to: a finished task must not be reopened.
      return {
        ...next,
        status: TASK_STATUSES.VERIFYING,
        ...(state.status === TASK_STATUSES.COMPLETED || state.status === TASK_STATUSES.FAILED
          ? { verificationReturnStatus: state.status }
          : {})
      };
    }

    case RUNTIME_EVENT_TYPES.TASK_COMPLETED: {
      if (state.status !== TASK_STATUSES.RUNNING && state.status !== TASK_STATUSES.VERIFYING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      const completedSteps = event.payload.completedSteps ?? state.completedSteps;
      const completed = {
        ...next,
        status: TASK_STATUSES.COMPLETED,
        completedSteps
      };
      delete completed.currentStep;
      delete completed.error;
      return completed;
    }

    case RUNTIME_EVENT_TYPES.TASK_FAILED:
      // A run can fail from any live state, including while waiting on a human
      // or while being verified; only terminal states are exempt.
      if (
        state.status !== TASK_STATUSES.RUNNING &&
        state.status !== TASK_STATUSES.PLANNING &&
        state.status !== TASK_STATUSES.WAITING &&
        state.status !== TASK_STATUSES.VERIFYING &&
        state.status !== TASK_STATUSES.PENDING
      ) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.FAILED, error: event.payload.error };

    case RUNTIME_EVENT_TYPES.TASK_CANCELLED: {
      if (
        state.status !== TASK_STATUSES.PENDING &&
        state.status !== TASK_STATUSES.RUNNING &&
        state.status !== TASK_STATUSES.PAUSED &&
        state.status !== TASK_STATUSES.FAILED
      ) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      const cancelled = { ...next, status: TASK_STATUSES.CANCELLED };
      delete cancelled.currentStep;
      return cancelled;
    }

    case RUNTIME_EVENT_TYPES.CHECKPOINT_CREATED:
      if (event.payload.checkpoint.taskId !== state.taskId) {
        throw new RuntimeError({
          code: ERROR_CODES.CORRUPT_LEDGER,
          message: "Checkpoint task id does not match event task id",
          details: { taskId: state.taskId, checkpointTaskId: event.payload.checkpoint.taskId }
        });
      }
      if (state.status === TASK_STATUSES.COMPLETED || state.status === TASK_STATUSES.CANCELLED) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      if (event.payload.checkpoint.eventSequence > state.lastEventSequence) {
        throw new RuntimeError({
          code: ERROR_CODES.CORRUPT_LEDGER,
          message: "Checkpoint points beyond the current task state",
          details: {
            taskId: state.taskId,
            checkpointSequence: event.payload.checkpoint.eventSequence,
            currentSequence: state.lastEventSequence
          }
        });
      }
      return { ...next, lastCheckpointId: event.payload.checkpoint.checkpointId };

    case RUNTIME_EVENT_TYPES.CHECKPOINT_RESTORED:
      if (state.status === TASK_STATUSES.COMPLETED || state.status === TASK_STATUSES.CANCELLED) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      requireTaskId(state.taskId, event.payload.state.taskId);
      if (
        event.payload.state.status === TASK_STATUSES.COMPLETED ||
        event.payload.state.status === TASK_STATUSES.CANCELLED
      ) {
        throw new RuntimeError({
          code: ERROR_CODES.INVALID_STATE_TRANSITION,
          message: "A checkpoint with a terminal state cannot be restored",
          details: { taskId: state.taskId, status: event.payload.state.status }
        });
      }
      return {
        ...event.payload.state,
        lastEventSequence: event.sequence,
        lastCheckpointId: event.payload.checkpointId
      };

    case RUNTIME_EVENT_TYPES.VERIFICATION_RECORDED: {
      const recorded = { ...next, verification: event.payload.result };
      // Checking is a phase, not an end: hand control back to whatever the task
      // was doing, so verifying a finished task leaves it finished.
      if (recorded.status === TASK_STATUSES.VERIFYING) {
        const back = state.verificationReturnStatus ?? TASK_STATUSES.RUNNING;
        recorded.status = back;
        delete recorded.verificationReturnStatus;
      }
      return recorded;
    }

    // A user turn reopens a finished conversation. The prior turns stay in the
    // log, so the model continues from its own history instead of starting over.
    case RUNTIME_EVENT_TYPES.USER_MESSAGE: {
      if (state.status === TASK_STATUSES.CANCELLED) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      const reopened = { ...next, status: TASK_STATUSES.PENDING };
      delete reopened.currentStep;
      delete reopened.error;
      return reopened;
    }

    default:
      return event satisfies never;
  }
}

export function replayRuntimeEvents(events: readonly RuntimeEvent[]): TaskState {
  let state: TaskState | undefined;
  for (const event of events) {
    state = applyRuntimeEvent(state, event);
  }
  if (state === undefined) {
    throw new RuntimeError({
      code: ERROR_CODES.CORRUPT_LEDGER,
      message: "Task has no events"
    });
  }
  return state;
}
