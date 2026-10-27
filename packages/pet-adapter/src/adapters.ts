import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "@agent/protocol";
import type { PetAdapter, PetEvent, PetState, PetTransport, VoiceAdapter } from "./types.js";
import { mapRuntimeEvent } from "./mapper.js";

export class FakePetAdapter implements PetAdapter {
  private state: PetState = "idle";
  readonly events: PetEvent[] = [];
  private connected = false;

  async connect(): Promise<void> { this.connected = true; }
  async disconnect(): Promise<void> { this.connected = false; }
  async publish(event: PetEvent): Promise<void> {
    if (!this.connected) throw new Error("FakePetAdapter is disconnected");
    this.state = event.state;
    this.events.push(event);
  }
  getState(): PetState { return this.state; }
}

export interface Live2DAdapterOptions {
  readonly createTransport: () => Promise<PetTransport>;
  readonly retryMs?: number;
}

export class Live2DPetAdapter implements PetAdapter {
  private transport: PetTransport | undefined;
  private state: PetState = "idle";
  private readonly queue: PetEvent[] = [];
  private readonly createTransport: () => Promise<PetTransport>;
  private readonly retryMs: number;
  private reconnecting = false;

  constructor(options: Live2DAdapterOptions) {
    this.createTransport = options.createTransport;
    this.retryMs = options.retryMs ?? 100;
  }

  async connect(): Promise<void> {
    this.transport = await this.createTransport();
    await this.flush();
  }

  async disconnect(): Promise<void> {
    await this.transport?.close?.();
    this.transport = undefined;
  }

  async publish(event: PetEvent): Promise<void> {
    this.state = event.state;
    if (this.transport === undefined) {
      this.queue.push(event);
      void this.scheduleReconnect();
      return;
    }
    try { await this.transport.send(event); } catch {
      this.queue.unshift(event);
      this.transport = undefined;
      void this.scheduleReconnect();
    }
  }

  getState(): PetState { return this.state; }

  private async flush(): Promise<void> {
    while (this.transport !== undefined && this.queue.length > 0) {
      const event = this.queue.shift();
      if (event !== undefined) {
        try { await this.transport.send(event); } catch (error) { this.queue.unshift(event); this.transport = undefined; throw error; }
      }
    }
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.reconnecting || this.transport !== undefined) return;
    this.reconnecting = true;
    try {
      while (this.transport === undefined && this.queue.length > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.retryMs);
          timer.unref?.();
        });
        try { await this.connect(); } catch { /* retry while queued */ }
      }
    } finally {
      this.reconnecting = false;
    }
  }
}

export interface ElectronIpc {
  send(channel: string, event: PetEvent): void;
}

export class ElectronPetAdapter extends Live2DPetAdapter {
  constructor(ipc: ElectronIpc) {
    super({ createTransport: async () => ({ send: (event) => ipc.send("runtime-pet-event", event) }) });
  }
}

export class PetController {
  constructor(private readonly adapter: PetAdapter, private readonly voice?: VoiceAdapter) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<PetEvent> {
    const petEvent = mapRuntimeEvent(event);
    await this.adapter.publish(petEvent);
    if (petEvent.textDelta !== undefined) await this.voice?.speak(petEvent.textDelta);
    return petEvent;
  }

  async emitBubble(taskId: string, text: string): Promise<PetEvent> {
    const event: PetEvent = { eventId: randomUUID(), state: "thinking", timestamp: new Date().toISOString(), taskId, text, sourceType: "pet" };
    await this.adapter.publish(event);
    return event;
  }
}
