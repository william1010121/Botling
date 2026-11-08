// Math, 2026-11-08: it promised "示範做好後我先給你看", the worker finished, and the next reply was only
// "我把這個待決定的事項寫進記錄了，你選好後我就開始。" — no demo picture or video, no choices block; the decision
// went only into memory's "Waiting on you". The report's wake note asked for "a sentence or two", and the
// choices rule's "Also write it into memory" read as a substitute. Both now say the reply itself shows them.
import { describe, expect, it } from "vitest";
import { REPORT_TAIL } from "../../src/core/worker-core/report";
import { botPrompts, CHOICES_NOT_MEMORY_RULE } from "../../src/core/prompts";

describe("a finished worker's result reaches the user in the reply", () => {
  it("the report note asks to show promised pictures or videos and any decision as a choices block, in that reply", () => {
    expect(REPORT_TAIL.none).toContain("![caption](file://");
    expect(REPORT_TAIL.none).toContain("choices block");
    expect(REPORT_TAIL.none).toMatch(/same reply/);
    expect(REPORT_TAIL.none).toMatch(/memory/);
    // Its continue / stop instructions stay.
    expect(REPORT_TAIL.none).toContain("app_send_message");
    expect(REPORT_TAIL.none).toContain("app_cancel_task");
  });

  it("the choices rule says the memory note is besides the choices block, never instead of it", () => {
    const profile = { name: "Math", role: "bot" as const, folder: "/fixture", memoryPath: ".bot/memory.md", job: null };
    for (const language of ["en", "zh-Hant"] as const) {
      const { system } = botPrompts({ profile, language });
      expect(system).toContain(CHOICES_NOT_MEMORY_RULE);
      expect(system.indexOf(CHOICES_NOT_MEMORY_RULE)).toBeGreaterThan(system.indexOf("section of your memory file."));
    }
  });
});
