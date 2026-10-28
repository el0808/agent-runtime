import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./provider.js";
import { toAnthropicPayload } from "./anthropic-provider.js";
import { keywordsOf, rebuildConversation } from "./index.js";
import type { RuntimeEvent } from "@agent/protocol";

function event<T extends RuntimeEvent["type"]>(type: T, payload: Extract<RuntimeEvent, { type: T }>["payload"]): RuntimeEvent {
  return { eventId: `${type}-1`, taskId: "t", sequence: 1, occurredAt: new Date().toISOString(), type, payload } as RuntimeEvent;
}

describe("conversation rebuild", () => {
  it("reconstructs assistant tool calls and their results from the event log", () => {
    const events: RuntimeEvent[] = [
      event("model.completed", { sessionId: "s", requestId: "r1", text: "checking", finishReason: "tool_call" }),
      event("tool.requested", {
        sessionId: "s",
        call: { callId: "c1", toolName: "read_file", input: { path: "a.txt" }, status: "requested" }
      }),
      event("tool.completed", { sessionId: "s", callId: "c1", output: { content: "hi" }, completedAt: "now", durationMs: 1 })
    ];
    const messages = rebuildConversation(events, "read a.txt");

    expect(messages[0]).toEqual({ role: "user", content: "read a.txt" });
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.toolCalls?.[0]).toMatchObject({ callId: "c1", toolName: "read_file" });
    expect(messages[2]).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  it("creates an assistant turn when the model called a tool without text", () => {
    const events: RuntimeEvent[] = [
      event("tool.requested", {
        sessionId: "s",
        call: { callId: "c9", toolName: "list_dir", input: {}, status: "requested" }
      })
    ];
    const messages = rebuildConversation(events, "list");
    expect(messages[1]).toMatchObject({ role: "assistant", content: "" });
    expect(messages[1]?.toolCalls?.[0]?.callId).toBe("c9");
  });
});

describe("anthropic payload", () => {
  it("hoists system messages and nests tool results in a user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "read it" },
      { role: "assistant", content: "", toolCalls: [{ callId: "c1", toolName: "read_file", input: { path: "a" } }] },
      { role: "tool", toolCallId: "c1", content: "contents" }
    ];
    const payload = toAnthropicPayload(messages, "claude-sonnet-5-5", 1024);
    expect(payload.system).toBe("be brief");
    const converted = payload.messages as { role: string; content: unknown }[];
    expect(converted[0]).toEqual({ role: "user", content: "read it" });
    expect(converted[1]?.role).toBe("assistant");
    const assistantBlocks = converted[1]?.content as { type: string }[];
    expect(assistantBlocks[0]?.type).toBe("tool_use");
    const last = converted[2]?.content as { type: string; tool_use_id: string }[];
    expect(last[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
  });
});

describe("memory keywords", () => {
  it("drops stop words and extracts latin words plus CJK bigrams", () => {
    const terms = keywordsOf("please read the README and 总结要点");
    expect(terms).toContain("read");
    expect(terms).toContain("readme");
    expect(terms).not.toContain("the");
    expect(terms.some((term) => /[一-鿿]/u.test(term))).toBe(true);
  });
});
