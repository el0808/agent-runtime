import { spawn } from "node:child_process";
import type { VoiceAdapter } from "./types.js";

export interface SystemTtsOptions {
  /** Spoken language tag, e.g. "zh-CN" or "en-US". */
  readonly lang?: string;
  /** Speech rate multiplier. */
  readonly rate?: number;
  /** Voice name passed to the platform synthesizer. */
  readonly voiceName?: string;
}

function commandFor(text: string, options: SystemTtsOptions): { command: string; args: string[] } | undefined {
  const rate = options.rate ?? 1;
  if (process.platform === "darwin") {
    // macOS `say` takes words-per-minute, default 175.
    const args = ["-r", String(Math.round(175 * rate))];
    if (options.voiceName !== undefined) {
      args.push("-v", options.voiceName);
    }
    return { command: "say", args: [...args, text] };
  }
  if (process.platform === "linux") {
    const args = ["-s", String(Math.round(175 * rate))];
    if (options.voiceName !== undefined) {
      args.push("-v", options.voiceName);
    }
    return { command: "espeak-ng", args: [...args, text] };
  }
  return undefined;
}

/**
 * Speaks through the operating system synthesizer, so no API key or network is
 * involved. Mouth movement is driven by estimated speech duration, because the
 * platform synthesizers report no phoneme timing.
 */
export class SystemTtsVoice implements VoiceAdapter {
  private mouth = 0;
  private speaking = false;
  private readonly options: SystemTtsOptions;
  /** Longest text spoken in one go; longer text is truncated to stay responsive. */
  private readonly maxChars: number;

  constructor(options: SystemTtsOptions & { maxChars?: number } = {}) {
    this.options = options;
    this.maxChars = options.maxChars ?? 400;
  }

  async speak(text: string): Promise<void> {
    const spoken = text.slice(0, this.maxChars).replace(/\s+/gu, " ").trim();
    if (spoken === "") {
      return;
    }
    const plan = commandFor(spoken, this.options);
    if (plan === undefined) {
      // No synthesizer on this platform: still drive the mouth so the pet reacts.
      await this.animate(spoken.length);
      return;
    }
    this.speaking = true;
    try {
      await new Promise<void>((resolve) => {
        const child = spawn(plan.command, plan.args, { stdio: "ignore" });
        const animation = this.animate(spoken.length);
        child.once("error", () => {
          void animation.then(resolve);
        });
        child.once("close", () => {
          void animation.then(resolve);
        });
      });
    } finally {
      this.speaking = false;
      this.mouth = 0;
    }
  }

  setMouthOpen(value: number): void {
    this.mouth = Math.max(0, Math.min(1, value));
  }

  /** Current mouth opening, for a renderer polling the adapter. */
  getMouthOpen(): number {
    return this.mouth;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  private async animate(length: number): Promise<void> {
    // ~14 characters per second is close to natural speech at rate 1.
    const durationMs = Math.max(300, Math.min(8000, (length / 14) * 1000));
    const started = Date.now();
    while (Date.now() - started < durationMs) {
      const phase = (Date.now() - started) / 110;
      this.mouth = 0.35 + Math.abs(Math.sin(phase)) * 0.65;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    this.mouth = 0;
  }
}

/** Voice adapter for hosts with no audio output; keeps the interface uniform. */
export class NullVoice implements VoiceAdapter {
  private mouth = 0;

  async speak(): Promise<void> {
    this.mouth = 0;
  }

  setMouthOpen(value: number): void {
    this.mouth = Math.max(0, Math.min(1, value));
  }

  getMouthOpen(): number {
    return this.mouth;
  }
}
