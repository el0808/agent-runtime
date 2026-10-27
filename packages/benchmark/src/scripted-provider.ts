import { FakeProvider } from "@agent/runner";
import type { LongTaskCase } from "./types.js";

/**
 * Builds a scripted model for one benchmark case. The script exercises the real
 * policy, approval, verification and recovery paths rather than short-circuiting
 * them, so the measured success rate reflects the harness, not the script.
 *
 * Every tool call gets a unique callId: the ledger rejects a callId it has
 * already seen, and a paused-then-resumed run replays later turns.
 */
export function createScriptedProvider(task: LongTaskCase, workspaceFile: string): FakeProvider {
  let sequence = 0;
  const nextId = (suffix: string): string => `${task.id}-${(sequence += 1)}-${suffix}`;

  const readStep = () => ({
    events: [
      { type: "delta" as const, text: "inspecting the workspace" },
      { type: "tool_call" as const, callId: nextId("read"), toolName: "read_file", input: { path: workspaceFile } },
      { type: "completed" as const, finishReason: "tool_call" as const }
    ]
  });

  const writeStep = () => ({
    events: [
      {
        type: "tool_call" as const,
        callId: nextId("write"),
        toolName: "write_file",
        input: { path: `out-${task.id}.txt`, content: task.prompt }
      },
      { type: "completed" as const, finishReason: "tool_call" as const }
    ]
  });

  const finishStep = () => ({
    events: [
      { type: "delta" as const, text: "task finished" },
      { type: "completed" as const, finishReason: "stop" as const }
    ]
  });

  // Approval-gated tasks need a retry after the pause; plain tasks finish in two turns.
  const turns = task.requiresApproval || task.requiresRecovery
    ? [readStep(), writeStep(), writeStep(), finishStep(), finishStep()]
    : [readStep(), finishStep(), finishStep()];

  return new FakeProvider(turns);
}
