// Task cards are gone (2026-11-08, the user: "the task part can go entirely, I never look at it"). The bots are no
// longer told to write <task …/> lines, and a line an older or other bot still writes is taken out of the chat
// silently: never shown as a raw tag, and nothing is built from it.
import { describe, expect, it } from "vitest";
import { botPrompts, codexWorkerInstructions, desktopPrompts } from "../../src/core/prompts";
import { parseReply } from "../../src/core/reply";

const profile = (role: "main" | "manager" | "bot") => ({ id: `id-${role}`, name: "P", role, folder: "/p/repo", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "Read news" : null, instructions: null });
const heads = { handoffs: true, limits: { handoffs: 3, review: 2, discussion: 2 } };

describe("a <task> tag is stripped and not rendered", () => {
  it("takes self-closing, paired and multiple task lines out of the body", () => {
    const parsed = parseReply([
      "Working on it.",
      "<task name=\"Worker finder proposals\" now=\"reading\" next=\"report\" state=\"waiting\"/>",
      "<task name='Bolting 吉祥物' state=\"running\" stage=\"built\"></task>",
      "Done soon.",
    ].join("\n"));
    expect(parsed.body).not.toMatch(/<\/?task\b/);
    expect(parsed.body).toContain("Working on it.");
    expect(parsed.body).toContain("Done soon.");
    expect(parsed).not.toHaveProperty("tasks");
  });

  it("a reply that is only a task line shows nothing", () => {
    expect(parseReply("<task name=\"x\" state=\"done\"/>").body.trim()).toBe("");
  });

  it("leaves a task tag inside code alone (an example, not a request)", () => {
    expect(parseReply("Write `<task name=\"x\"/>` like this.").body).toContain("`<task name=\"x\"/>`");
  });
});

describe("the prompts have no task rule", () => {
  for (const role of ["main", "manager", "bot"] as const) for (const engine of ["claude", "codex", "agy"] as const) for (const h of [null, heads]) {
    it(`${role}/${engine}/${h ? "heads" : "solo"}`, () => {
      const plain = botPrompts({ profile: profile(role), engine, heads: h, language: "en" });
      const shown = desktopPrompts(plain, profile(role), engine);
      for (const prompts of [plain, shown]) for (const [key, text] of Object.entries(prompts)) {
        if (typeof text !== "string") continue;
        expect(text, key).not.toMatch(/<task[\s/>]/);
        expect(text, key).not.toMatch(/task card/i);
        expect(text, key).not.toMatch(/stage \(optional\) is built/);
      }
    });
  }
  it("worker instructions", () => {
    expect(codexWorkerInstructions(profile("manager"), "en")).not.toMatch(/<task[\s/>]/);
  });
});
