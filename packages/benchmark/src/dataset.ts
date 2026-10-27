import type { LongTaskCase } from "./types.js";

export const LONG_TASK_CATEGORIES = ["multi-file", "tool-failure", "approval", "network-disconnect", "model-timeout", "process-crash", "device-switch", "compression", "partial-rollback", "full-recovery"] as const;

export function createLongTaskRR(countPerCategory = 30): readonly LongTaskCase[] {
  if (!Number.isInteger(countPerCategory) || countPerCategory < 1) throw new Error("countPerCategory must be positive");
  return LONG_TASK_CATEGORIES.flatMap((category) => Array.from({ length: countPerCategory }, (_, index) => ({
    id: `long-task-rr-${category}-${String(index + 1).padStart(3, "0")}`,
    category,
    prompt: `Complete ${category} recovery task ${index + 1}`,
    requiresRecovery: ["tool-failure", "network-disconnect", "model-timeout", "process-crash", "device-switch", "full-recovery"].includes(category),
    requiresApproval: category === "approval" || category === "partial-rollback",
    requiresCompression: category === "compression" || category === "multi-file"
  })));
}
