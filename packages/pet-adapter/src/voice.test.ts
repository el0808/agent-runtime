import { describe, expect, it } from "vitest";
import { NullVoice, SystemTtsVoice } from "./voice.js";

describe("voice adapters", () => {
  it("clamps mouth opening to the 0..1 range", () => {
    const voice = new NullVoice();
    voice.setMouthOpen(2);
    expect(voice.getMouthOpen()).toBe(1);
    voice.setMouthOpen(-1);
    expect(voice.getMouthOpen()).toBe(0);
  });

  it("drives the mouth while speaking and releases it afterwards", async () => {
    // Long text keeps the animation running long enough to sample it.
    const voice = new SystemTtsVoice({ maxChars: 40 });
    let peak = 0;
    const speaking = voice.speak("this is a sentence that should animate the mouth");
    const sampled = (async () => {
      for (let index = 0; index < 12; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        peak = Math.max(peak, voice.getMouthOpen());
      }
    })();
    await Promise.all([speaking, sampled]);
    expect(peak).toBeGreaterThan(0);
    expect(voice.getMouthOpen()).toBe(0);
  });

  it("ignores empty input so an empty delta never animates", async () => {
    const voice = new SystemTtsVoice();
    await voice.speak("   ");
    expect(voice.getMouthOpen()).toBe(0);
  });
});
