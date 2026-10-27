import { describe, expect, it } from "vitest";
import { RuntimeError } from "@agent/protocol";
import { ToolRegistry } from "./registry.js";

describe("ToolRegistry", () => {
  it("executes a registered tool and preserves output", async () => {
    const registry = new ToolRegistry();
    registry.register({ name: "echo", description: "echo", execute: (input) => input });
    await expect(registry.execute("echo", { value: "ok" })).resolves.toMatchObject({ status: "succeeded", output: { value: "ok" } });
  });

  it("returns timeout and cancellation outcomes without throwing", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "wait",
      description: "wait",
      execute: (_input, context) => new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("done"), 100);
        context.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
      })
    });
    await expect(registry.execute("wait", {}, { timeoutMs: 5 })).resolves.toMatchObject({ status: "timed_out", timeoutMs: 5 });
    const controller = new AbortController();
    const running = registry.execute("wait", {}, { signal: controller.signal, timeoutMs: 1000 });
    controller.abort(new Error("user stopped"));
    await expect(running).resolves.toMatchObject({ status: "cancelled", reason: "user stopped" });
  });

  it("rejects duplicate and unknown tools", () => {
    const registry = new ToolRegistry();
    registry.register({ name: "echo", description: "echo", execute: (input) => input });
    expect(() => registry.register({ name: "echo", description: "again", execute: (input) => input })).toThrow(RuntimeError);
    expect(() => registry.get("missing")).toThrow(RuntimeError);
  });
});
