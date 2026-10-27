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
  TaskProfile
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

export function createInitialTaskState(profile: TaskProfile): TaskState {
  return {
    taskId: profile.taskId,
    status: TASK_STATUSES.PENDING,
    profile,
    completedSteps: [],
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
    case RUNTIME_EVENT_TYPES.TASK_STARTED:
      if (state.status !== TASK_STATUSES.PENDING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.RUNNING };

    case RUNTIME_EVENT_TYPES.TASK_PAUSED:
      if (state.status !== TASK_STATUSES.RUNNING) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      return { ...next, status: TASK_STATUSES.PAUSED };

    case RUNTIME_EVENT_TYPES.TASK_RESUMED:
      if (state.status !== TASK_STATUSES.PAUSED && state.status !== TASK_STATUSES.FAILED) {
        invalidTransition(state.taskId, state.status, event.type);
      }
      {
        const resumed = { ...next, status: TASK_STATUSES.RUNNING };
        delete resumed.error;
        return resumed;
      }

    case RUNTIME_EVENT_TYPES.TASK_COMPLETED: {
      if (state.status !== TASK_STATUSES.RUNNING) {
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
      if (state.status !== TASK_STATUSES.RUNNING) {
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

    case RUNTIME_EVENT_TYPES.VERIFICATION_RECORDED:
      return { ...next, verification: event.payload.result };

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
