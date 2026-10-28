import type { JsonObject, RuntimeEvent } from "@agent/protocol";
import type { AssistantToolCall, ChatMessage } from "./provider.js";

function resultText(payload: JsonObject): string {
  return JSON.stringify(payload);
}

/**
 * Rebuilds the chat history for a task from its event log.
 *
 * Everything needed is already recorded — assistant text on `model.completed`,
 * tool requests on `tool.requested`, and results on `tool.completed`/`failed`/
 * `timed_out`/`cancelled` — so a resumed task continues its conversation instead
 * of replaying from the goal. Nothing extra is written to the ledger.
 */
export function rebuildConversation(events: readonly RuntimeEvent[], goal: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "user", content: goal }];
  const callNames = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case "model.completed": {
        if (event.payload.text === "") {
          break;
        }
        messages.push({ role: "assistant", content: event.payload.text });
        break;
      }
      case "tool.requested": {
        const call = event.payload.call;
        callNames.set(call.callId, call.toolName);
        const assistant: AssistantToolCall = {
          callId: call.callId,
          toolName: call.toolName,
          input: call.input
        };
        // Attach to the assistant turn that issued it, creating one if the model
        // produced no text alongside the tool call.
        const last = messages[messages.length - 1];
        if (last !== undefined && last.role === "assistant") {
          messages[messages.length - 1] = {
            ...last,
            toolCalls: [...(last.toolCalls ?? []), assistant]
          };
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [assistant] });
        }
        break;
      }
      case "tool.completed":
      case "tool.failed":
      case "tool.timed_out":
      case "tool.cancelled": {
        const callId = event.payload.callId;
        const name = callNames.get(callId) ?? "tool";
        messages.push({
          role: "tool",
          toolCallId: callId,
          content: resultText({ tool: name, status: event.type.slice("tool.".length), payload: event.payload as unknown as JsonObject })
        });
        break;
      }
      default:
        break;
    }
  }

  return messages;
}
