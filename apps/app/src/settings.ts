import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ProviderId = "openai" | "openai-compatible" | "anthropic" | "fake";

export interface AppSettings {
  readonly provider: ProviderId;
  readonly model: string;
  readonly baseUrl: string;
  readonly workspaceRoot: string;
  /** Approving medium-risk tools without a prompt. Off by default on purpose. */
  readonly autoApproveMedium: boolean;
  readonly theme: "dark" | "light";
  readonly sendOnEnter: boolean;
  readonly voiceEnabled: boolean;
  readonly maxTurns: number;
  readonly contextTokenBudget: number;
  /** How hard the model should think, passed to providers that support it. */
  readonly reasoningEffort: "low" | "medium" | "high";
  /** Lets the agent read and run commands outside the workspace folder. */
  readonly allowOutsideWorkspace: boolean;
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: "openai-compatible",
  model: "gpt-6.1-sol",
  baseUrl: "https://api.fluxtoken.ai/v1",
  workspaceRoot: "",
  autoApproveMedium: false,
  theme: "light",
  sendOnEnter: true,
  voiceEnabled: false,
  maxTurns: 24,
  contextTokenBudget: 32_000,
  reasoningEffort: "medium",
  allowOutsideWorkspace: false,
  inputPricePerMillion: 2.5,
  outputPricePerMillion: 10
};

const KNOWN_PROVIDERS: readonly ProviderId[] = ["openai", "openai-compatible", "anthropic", "fake"];

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

/** Settings live in a single JSON file next to the runtime databases. */
export class SettingsStore {
  private readonly filename: string;
  private cache: AppSettings;

  constructor(filename: string) {
    this.filename = filename;
    mkdirSync(path.dirname(filename), { recursive: true });
    this.cache = this.load();
  }

  get(): AppSettings {
    return this.cache;
  }

  /** Merges a partial update and persists it, ignoring unknown fields. */
  update(patch: Partial<AppSettings>): AppSettings {
    const merged: AppSettings = {
      ...this.cache,
      ...(isProvider(patch.provider) ? { provider: patch.provider } : {}),
      ...(typeof patch.model === "string" && patch.model !== "" ? { model: patch.model } : {}),
      ...(typeof patch.baseUrl === "string" ? { baseUrl: patch.baseUrl } : {}),
      ...(typeof patch.workspaceRoot === "string" ? { workspaceRoot: patch.workspaceRoot } : {}),
      ...(typeof patch.autoApproveMedium === "boolean" ? { autoApproveMedium: patch.autoApproveMedium } : {}),
      ...(patch.theme === "dark" || patch.theme === "light" ? { theme: patch.theme } : {}),
      ...(typeof patch.sendOnEnter === "boolean" ? { sendOnEnter: patch.sendOnEnter } : {}),
      ...(typeof patch.voiceEnabled === "boolean" ? { voiceEnabled: patch.voiceEnabled } : {}),
      ...(Number.isInteger(patch.maxTurns) ? { maxTurns: Math.max(1, Math.min(200, Number(patch.maxTurns))) } : {}),
      ...(Number.isFinite(patch.contextTokenBudget) ? { contextTokenBudget: Math.max(1_000, Number(patch.contextTokenBudget)) } : {}),
      ...(patch.reasoningEffort === "low" || patch.reasoningEffort === "medium" || patch.reasoningEffort === "high"
        ? { reasoningEffort: patch.reasoningEffort }
        : {}),
      ...(typeof patch.allowOutsideWorkspace === "boolean" ? { allowOutsideWorkspace: patch.allowOutsideWorkspace } : {}),
      ...(Number.isFinite(patch.inputPricePerMillion) ? { inputPricePerMillion: Number(patch.inputPricePerMillion) } : {}),
      ...(Number.isFinite(patch.outputPricePerMillion) ? { outputPricePerMillion: Number(patch.outputPricePerMillion) } : {})
    };
    this.cache = merged;
    this.persist();
    return merged;
  }

  private load(): AppSettings {
    if (!existsSync(this.filename)) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const raw = JSON.parse(readFileSync(this.filename, "utf8")) as Partial<AppSettings>;
      return { ...DEFAULT_SETTINGS, ...raw };
    } catch {
      // A corrupt settings file must not stop the app from starting.
      return { ...DEFAULT_SETTINGS };
    }
  }

  private persist(): void {
    const temp = `${this.filename}.tmp`;
    writeFileSync(temp, JSON.stringify(this.cache, null, 2), "utf8");
    renameSync(temp, this.filename);
  }
}
