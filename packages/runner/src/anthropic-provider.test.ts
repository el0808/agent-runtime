import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic-provider.js";
import type { ModelStreamEvent } from "./provider.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

async function mockAnthropic(events: readonly unknown[]) {
  const payload = events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${port}/v1`;
}

async function collect(provider: AnthropicProvider) {
  const events: ModelStreamEvent[] = [];
  const controller = new AbortController();
  for await (const event of provider.chat({ model: "test", messages: [{ role: "user", content: "hi" }], tools: [] }, controller.signal)) {
    events.push(event);
  }
  return events;
}

describe("AnthropicProvider", () => {
  it("streams text and reports token usage", async () => {
    const baseUrl = await mockAnthropic([
      { type: "message_start", message: { usage: { input_tokens: 20 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "test", baseUrl });
    const events = await collect(provider);

    expect(events.filter((event) => event.type === "delta")).toHaveLength(1);
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: { promptTokens: 20, completionTokens: 5 }
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "stop" });
  });

  it("joins input_json_delta fragments into one tool call", async () => {
    const baseUrl = await mockAnthropic([
      { type: "message_start", message: { usage: { input_tokens: 9 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "write_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"out.txt","content":"x"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", model: "test", baseUrl });
    const events = await collect(provider);

    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      callId: "toolu_1",
      toolName: "write_file",
      input: { path: "out.txt", content: "x" }
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "tool_call" });
  });
});
