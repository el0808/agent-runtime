import path from "node:path";

export interface RuntimeConfig {
  readonly storageDir: string;
  readonly workspaceRoot: string;
  readonly autoApproveMedium: boolean;
  readonly deniedTools: readonly string[];
  readonly confidenceThreshold: number;
  readonly shadowMode: boolean;
  readonly toolTimeoutMs: number;
  readonly contextTokenBudget: number;
  readonly jevUrl?: string;
  /** USD per 1M tokens; only used to report cost, never to gate execution. */
  readonly pricing?: { readonly inputPerMillion: number; readonly outputPerMillion: number };
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  storageDir: "storage",
  workspaceRoot: process.cwd(),
  autoApproveMedium: false,
  deniedTools: [],
  confidenceThreshold: 0.75,
  shadowMode: false,
  toolTimeoutMs: 30_000,
  contextTokenBudget: 8_000
};

export function resolvePaths(config: RuntimeConfig): {
  ledger: string;
  memory: string;
  sync: string;
  device: string;
} {
  const base = path.resolve(config.storageDir);
  return {
    ledger: path.join(base, "runtime.db"),
    memory: path.join(base, "memory.db"),
    sync: path.join(base, "sync.json"),
    device: path.join(base, "device.json")
  };
}

/** Reads `AGENT_*` environment variables over the supplied defaults. */
export function configFromEnv(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  const env = process.env;
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    ...(env.AGENT_STORAGE_DIR === undefined ? {} : { storageDir: env.AGENT_STORAGE_DIR }),
    ...(env.AGENT_WORKSPACE_ROOT === undefined ? {} : { workspaceRoot: env.AGENT_WORKSPACE_ROOT }),
    ...(env.AGENT_JEV_URL === undefined ? {} : { jevUrl: env.AGENT_JEV_URL }),
    ...(env.AGENT_AUTO_APPROVE_MEDIUM === undefined ? {} : { autoApproveMedium: env.AGENT_AUTO_APPROVE_MEDIUM === "1" }),
    ...(env.AGENT_INPUT_PRICE === undefined ? {} : {
      pricing: {
        inputPerMillion: Number(env.AGENT_INPUT_PRICE),
        outputPerMillion: Number(env.AGENT_OUTPUT_PRICE ?? "0")
      }
    })
  };
}
