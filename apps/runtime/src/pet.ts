import type { RuntimeEvent } from "@agent/protocol";
import { PetController } from "@agent/pet-adapter";
import type { PetAdapter, VoiceAdapter } from "@agent/pet-adapter";

/**
 * Subscribes a pet adapter to a runtime event source. The pet only ever receives
 * mapped display events; it cannot reach providers, tools, or approvals.
 */
export function attachPet(
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void,
  adapter: PetAdapter,
  voice?: VoiceAdapter
): () => void {
  const controller = new PetController(adapter, voice);
  return subscribe((event) => {
    void controller.handleRuntimeEvent(event);
  });
}
