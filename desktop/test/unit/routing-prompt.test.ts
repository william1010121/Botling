// The routing rules approved 2026-11-04 reach every engine: discuss in chat when asked, restate a doubtful question
// first, text still being discussed stays short in chat (every page is a ReportSpec v2 report), a page
// opens by answering the question, and a worker's follow-ups go to that same worker with the user's own words.
import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/agent/agy-capabilities", async (original) => ({ ...await original<any>(), agyWorkerRuntimeEnabled: () => true }));
import { AGY_BREVITY_RULE, botPrompts, desktopPrompts, reportOnlyRule, resultsRule, RESTATE_RULE } from "../../src/core/prompts";

const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });
const ENGINES = ["claude", "codex", "agy"] as const;

describe("routing rules", () => {
  it("keeps text under discussion short in chat and requires ReportSpec v2 report pages and offers no .md file", () => {
    const rule = reportOnlyRule("/tmp/p/.bot/artifacts");
    expect(rule).toContain("stays short in chat.");
    expect(rule).toContain("is one report built from a ReportSpec v2 JSON with the report command");
    expect(rule).toContain('opens with one sentence that answers the user\'s question ("You asked X; the answer is Y"); if it cannot, do not publish it');
    expect(rule).not.toContain("<english-file-name>.md");
    expect(rule).not.toContain("still discussing, a .md file");
    for (const choice of ["artifactUnlessSensitive", "localOnly", "artifactAlways"] as const) expect(resultsRule(choice, "/a")).toContain(reportOnlyRule("/a"));
  });

  it("points long text to a report page, not a .md file", () => {
    expect(AGY_BREVITY_RULE).toContain("they go into a report page (see the results rule)");
    expect(AGY_BREVITY_RULE).not.toContain(".md");
  });

  for (const engine of ENGINES) {
    it(`reaches a ${engine} bot and manager: discuss in chat when asked, restate first, ReportSpec v2 only`, () => {
      for (const role of ["bot", "manager"] as const) {
        const { system } = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), engine, true);
        expect(system).toContain("when the user asks to discuss or think something through together, discuss it in chat");
        expect(system).toContain(RESTATE_RULE.slice(2));
        expect(system).toContain("怪怪的, 為什麼, 看不懂");
        expect(system).toContain("stays short in chat.");
        expect(system).toContain("one report built from a ReportSpec v2 JSON");
        expect(system).not.toContain("Markdown file instead");
        expect(system).not.toContain("<english-file-name>.md");
      }
    });

    it(`tells a ${engine} coordinator to keep follow-ups with the same worker and quote the user`, () => {
      for (const role of ["main", "manager", "bot"] as const) {
        const { system } = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), engine, true);
        expect(system, role).toContain("A follow-up on a worker's result goes to that same worker, not a new one.");
        expect(system, role).toContain("Every handoff and follow-up quotes the user's own words of their question.");
      }
    });
  }
});
