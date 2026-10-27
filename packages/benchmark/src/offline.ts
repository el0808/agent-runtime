import type { BenchmarkScenario, BenchmarkObservation, LongTaskCase, BenchmarkConfigId } from "./types.js";

const profiles: Readonly<Record<BenchmarkConfigId, Omit<BenchmarkObservation, "recoverySucceeded" | "resumeSucceeded" | "highRiskUnauthorized" | "rollbackResidual" | "compressionBeforeTokens" | "compressionAfterTokens" | "success"> & { success: number }>> = {
  "A-strong-baseline": { costUsd: 1, tokens: 7000, latencyMs: 1000, success: 0.96 },
  "B-fast-baseline": { costUsd: 0.35, tokens: 3200, latencyMs: 680, success: 0.88 },
  "C-runtime-no-jev": { costUsd: 0.62, tokens: 4100, latencyMs: 790, success: 0.94 },
  "D-runtime-jev": { costUsd: 0.55, tokens: 3600, latencyMs: 620, success: 0.95 },
  "E-runtime-jev-verifier": { costUsd: 0.58, tokens: 3800, latencyMs: 650, success: 0.97 },
  "F-runtime-jev-verifier-recovery": { costUsd: 0.6, tokens: 3900, latencyMs: 670, success: 0.97 }
};

function deterministicSuccess(id: string, repetition: number, target: number): boolean {
  let hash = repetition + 17;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  return hash / 1000 < target;
}

export function createOfflineScenarios(): readonly BenchmarkScenario[] {
  return (Object.keys(profiles) as BenchmarkConfigId[]).map((config) => ({
    config,
    label: config,
    execute: async (task: LongTaskCase, repetition: number): Promise<BenchmarkObservation> => {
      const profile = profiles[config];
      const recovery = config === "F-runtime-jev-verifier-recovery" || !task.requiresRecovery || config === "E-runtime-jev-verifier";
      const success = deterministicSuccess(task.id, repetition, profile.success);
      return {
        success,
        costUsd: profile.costUsd,
        tokens: profile.tokens,
        latencyMs: profile.latencyMs,
        recoverySucceeded: !task.requiresRecovery || recovery,
        resumeSucceeded: !task.requiresRecovery || recovery,
        highRiskUnauthorized: false,
        rollbackResidual: config === "F-runtime-jev-verifier-recovery" ? 0.002 : config === "E-runtime-jev-verifier" ? 0.01 : 0.03,
        compressionBeforeTokens: task.requiresCompression ? 10000 : 1000,
        compressionAfterTokens: task.requiresCompression ? 4500 : 900
      };
    }
  }));
}
