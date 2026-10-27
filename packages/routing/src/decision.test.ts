import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RUNNER_TYPES } from "@agent/protocol";
import { TaskLedger } from "@agent/task-ledger";
import { DecisionRouter, JevDecisionProvider, RulesDecisionProvider, type DecisionContext, type DecisionProvider } from "./decision.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function ledgerFor(taskId = "decision") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-decision-"));
  dirs.push(dir);
  const ledger = new TaskLedger({ filename: path.join(dir, "ledger.sqlite") });
  ledger.createTask({ taskId, goal: "choose safely", runnerType: RUNNER_TYPES.DIRECT });
  return ledger;
}

const context: DecisionContext = { taskId: "decision", goal: "choose safely", kind: "tool", options: ["fast", "strong"], risk: "low", failureCount: 0 };

describe("DecisionRouter", () => {
  it("uses Jev when confidence is high and records latency", async () => {
    const ledger = await ledgerFor();
    const jev = new JevDecisionProvider({ transport: async () => ({ choice: "strong", confidence: 0.95, reason: "complex" }) });
    const router = new DecisionRouter({ ledger, jev, confidenceThreshold: 0.75 });
    await expect(router.decide(context)).resolves.toMatchObject({ provider: "jev", choice: "strong" });
    expect(ledger.getEvents("decision").at(-1)?.type).toBe("decision.evaluated");
    ledger.close();
  });

  it("falls back on timeout and low confidence, while high-risk approval stays deterministic", async () => {
    const ledger = await ledgerFor();
    const slow = new JevDecisionProvider({ timeoutMs: 5, transport: async () => new Promise((resolve) => setTimeout(() => resolve({ choice: "fast", confidence: 1 }), 100)) });
    const router = new DecisionRouter({ ledger, jev: slow });
    await expect(router.decide(context)).resolves.toMatchObject({ provider: "rules", fallback: true });
    const unsafe: DecisionContext = { ...context, kind: "approval", options: ["approve", "review"], risk: "critical" };
    const unsafeResult = await router.decide(unsafe);
    expect(unsafeResult.choice).toBe("review");
    expect(unsafeResult.provider).toBe("rules");
    ledger.close();
  });

  it("supports Shadow Mode without letting Jev change the authoritative result", async () => {
    const ledger = await ledgerFor();
    const jev: DecisionProvider = { name: "jev", decide: async () => ({ provider: "jev", choice: "strong", confidence: 0.99, reason: "shadow", latencyMs: 1 }) };
    const router = new DecisionRouter({ ledger, jev, shadowMode: true });
    const result = await router.decide(context);
    expect(result.provider).toBe("rules");
    const events = ledger.getEvents("decision").filter((event) => event.type === "decision.evaluated");
    expect(events).toHaveLength(2);
    expect(events[0]?.payload.authoritative).toBe(false);
    expect(events[1]?.payload.authoritative).toBe(true);
    ledger.close();
  });

  it("keeps RulesDecisionProvider deterministic", async () => {
    const rules = new RulesDecisionProvider();
    await expect(rules.decide({ ...context, kind: "escalate", options: ["fast", "strong"], failureCount: 2 })).resolves.toMatchObject({ choice: "strong", confidence: 1 });
  });
});
