import type { RuntimeEvent } from "@agent/protocol";

export type PetState = "idle" | "listening" | "thinking" | "working" | "waiting_approval" | "verifying" | "success" | "error" | "sleeping";

export interface PetEvent {
  readonly eventId: string;
  readonly state: PetState;
  readonly timestamp: string;
  readonly taskId?: string;
  readonly textDelta?: string;
  readonly text?: string;
  readonly sourceType: RuntimeEvent["type"] | "pet";
}

export interface PetTransport {
  send(event: PetEvent): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface PetAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(event: PetEvent): Promise<void>;
  getState(): PetState;
}

export interface VoiceAdapter {
  speak(text: string): Promise<void>;
  setMouthOpen(value: number): void;
}
