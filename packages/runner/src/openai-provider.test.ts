import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAIChatProvider } from "./openai-provider.js";
import type { ModelStreamEvent } from "./provider.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => server.close())));

function sse(chunks: readonly string[]): string {
  return chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
}

/** Serves a canned OpenAI stream so the provider is tested without a real API. */
async function mockOpenAI(chunks: readonly string[]) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse(chunks));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  servers.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${port}/v1`;
}

async function collect(provider: OpenAIChatProvider, messages: Parameters<OpenAIChatProvider["chat"]>[0]["messages"]) {
  const events: ModelStreamEvent[] = [];
  const controller = new AbortController();
  for await (const event of provider.chat({ model: "test", messages, tools: [] }, controller.signal)) {
    events.push(event);
  }
  return events;
}

describe("OpenAIChatProvider", () => {
  it("streams text deltas and reports usage", async () => {
    const baseUrl = await mockOpenAI([
      JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })
    ]);
    const provider = new OpenAIChatProvider({ apiKey: "test", model: "test", baseUrl });
    const events = await collect(provider, [{ role: "user", content: "hi" }]);

    const text = events.filter((event) => event.type === "delta").map((event) => (event as { text: string }).text).join("");
    expect(text).toBe("Hello");
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: { promptTokens: 12, completionTokens: 3 }
    });
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "stop" });
  });

  it("accumulates fragmented tool arguments across chunks", async () => {
    const baseUrl = await mockOpenAI([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
    ]);
    const provider = new OpenAIChatProvider({ apiKey: "test", model: "test", baseUrl });
    const events = await collect(provider, [{ role: "user", content: "read" }]);

    const call = events.find((event) => event.type === "tool_call");
    expect(call).toMatchObject({ callId: "call_1", toolName: "read_file", input: { path: "a.txt" } });
    expect(events.at(-1)).toMatchObject({ type: "completed", finishReason: "tool_call" });
  });

  it("rejects malformed tool arguments instead of passing them through", async () => {
    const baseUrl = await mockOpenAI([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "write_file", arguments: "{not json" } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
    ]);
    const provider = new OpenAIChatProvider({ apiKey: "test", model: "test", baseUrl });
    await expect(collect(provider, [{ role: "user", content: "x" }])).rejects.toThrow(/invalid JSON/i);
  });
});
