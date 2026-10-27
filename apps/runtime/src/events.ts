import type { RuntimeEvent } from "@agent/protocol";

export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * Fan-out for runtime events. Subscribers receive every appended event, whether
 * it came from a runner stream or from an out-of-band API call (approval, pause).
 */
export class EventBus {
  private readonly listeners = new Set<RuntimeEventListener>();

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never abort the task that produced the event.
      }
    }
  }
}
