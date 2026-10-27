import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@agent/protocol";
import { ElectronPetAdapter, FakePetAdapter, Live2DPetAdapter, PetController, mapRuntimeEvent } from "./index.js";

function event<T extends RuntimeEvent["type"]>(type: T, payload: Extract<RuntimeEvent, { type: T }>['payload']): RuntimeEvent {
  return { eventId: `${type}-1`, taskId: "task", sequence: 1, occurredAt: new Date().toISOString(), type, payload } as RuntimeEvent;
}

describe("pet adapter", () => {
  it("maps runtime events to display states and streams bubbles", async () => {
    const adapter = new FakePetAdapter();
    await adapter.connect();
    const spoken: string[] = [];
    const controller = new PetController(adapter, { speak: async (text) => { spoken.push(text); }, setMouthOpen: () => undefined });
    await controller.handleRuntimeEvent(event("task.started", {}));
    await controller.handleRuntimeEvent(event("model.delta", { sessionId: "s", requestId: "r", text: "hello" }));
    await controller.handleRuntimeEvent(event("approval.requested", { approvalId: "a", toolName: "write_file", risk: "high", reason: "review" }));
    expect(adapter.getState()).toBe("waiting_approval");
    expect(adapter.events[1]?.textDelta).toBe("hello");
    expect(spoken).toEqual(["hello"]);
    expect(mapRuntimeEvent(event("task.failed", { error: { code: "x", message: "failed" } })).state).toBe("error");
  });

  it("queues events and reconnects a Live2D transport", async () => {
    const received: string[] = [];
    const adapter = new Live2DPetAdapter({ retryMs: 5, createTransport: async () => ({ send: (petEvent) => { received.push(petEvent.state); } }) });
    await adapter.publish({ eventId: "e", state: "working", timestamp: new Date().toISOString(), taskId: "task", sourceType: "pet" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toEqual(["working"]);
    expect(adapter.getState()).toBe("working");
    await adapter.disconnect();
  });

  it("keeps Electron integration at an IPC boundary", async () => {
    const channels: string[] = [];
    const adapter = new ElectronPetAdapter({ send: (channel) => { channels.push(channel); } });
    await adapter.connect();
    await adapter.publish({ eventId: "e", state: "idle", timestamp: new Date().toISOString(), sourceType: "pet" });
    expect(channels).toEqual(["runtime-pet-event"]);
    await adapter.disconnect();
  });
});
