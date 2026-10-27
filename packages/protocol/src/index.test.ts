import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  RuntimeError,
  createLogRecord,
  serializeLogRecord
} from "./index.js";

describe("protocol contracts", () => {
  it("serializes a stable runtime error", () => {
    const error = new RuntimeError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "Task id is required",
      details: { field: "taskId" }
    });

    expect(error.toJSON()).toEqual({
      code: "INVALID_INPUT",
      message: "Task id is required",
      details: { field: "taskId" }
    });
  });

  it("creates an ISO timestamped JSON log record", () => {
    const record = createLogRecord(
      {
        level: "info",
        event: "task.created",
        message: "Task created",
        context: { taskId: "task-1" }
      },
      new Date("2026-10-27T09:00:00.000Z")
    );

    expect(serializeLogRecord(record)).toBe(
      '{"timestamp":"2026-10-27T09:00:00.000Z","level":"info","event":"task.created","message":"Task created","context":{"taskId":"task-1"}}'
    );
  });
});
