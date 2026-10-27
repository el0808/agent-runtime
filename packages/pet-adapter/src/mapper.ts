import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@agent/protocol";
import type { PetEvent, PetState } from "./types.js";

function base(event: RuntimeEvent, state: PetState): PetEvent {
  return { eventId: randomUUID(), state, timestamp: new Date().toISOString(), taskId: event.taskId, sourceType: event.type };
}

export function mapRuntimeEvent(event: RuntimeEvent): PetEvent {
  switch (event.type) {
    case "task.created": return base(event, "listening");
    case "task.started":
    case "session.started": return base(event, "thinking");
    case "model.requested": return base(event, "thinking");
    case "model.delta": return { ...base(event, "thinking"), textDelta: event.payload.text };
    case "tool.requested": return base(event, "working");
    case "approval.requested": return base(event, "waiting_approval");
    case "verification.recorded": return base(event, "verifying");
    case "context.compressed": return base(event, "thinking");
    case "task.completed": return base(event, "success");
    case "session.ended": return base(event, event.payload.status === "paused" ? "sleeping" : event.payload.status === "failed" ? "error" : event.payload.status === "cancelled" ? "idle" : "success");
    case "task.failed":
    case "model.failed":
    case "tool.failed": return base(event, "error");
    case "task.paused": return base(event, "sleeping");
    case "task.cancelled": return base(event, "idle");
    default: return base(event, "working");
  }
}
