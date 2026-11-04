// The routing rules approved 2026-11-04 reach every engine: discuss in chat when asked, restate a doubtful question
// first, long text still being discussed goes into one .md file (pages only for settled visual results), a page or .md
// opens by answering the question, and a worker's follow-ups go to that same worker with the user's own words.
import { describe, expect, it, vi } from "vitest";
vi.mock("../../src/core/agent/agy-capabilities", async (original) => ({ ...await original<any>(), agyWorkerRuntimeEnabled: () => true }));
import { botPrompts, desktopPrompts, markdownRule, resultsRule, RESTATE_RULE } from "../../src/core/prompts";

const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });
const ENGINES = ["claude", "codex", "agy"] as const;

describe("routing rules", () => {
  it("sends long text still under discussion to one .md in the artifacts folder, edited in place", () => {
    const rule = markdownRule("/tmp/p/.bot/artifacts");
    expect(rule).toContain("saved to /tmp/p/.bot/artifacts/<english-file-name>.md and linked as [name](file://full path of that file)");
    expect(rule).toContain("edit that file in place");
    expect(rule).toContain("still discussing, a .md file; settled and needs charts, a page");
    expect(rule).toContain('opens with one sentence that answers the user\'s question ("You asked X; the answer is Y"); if it cannot, do not publish it');
    for (const choice of ["artifactUnlessSensitive", "localOnly", "artifactAlways"] as const) expect(resultsRule(choice, "/a")).toContain(markdownRule("/a"));
  });

  for (const engine of ENGINES) {
    it(`reaches a ${engine} bot and manager: discuss in chat when asked, restate first, .md routing`, () => {
      for (const role of ["bot", "manager"] as const) {
        const { system } = desktopPrompts(botPrompts({ profile: profile(role), engine }), profile(role), engine, true);
        expect(system).toContain("when the user asks to discuss or think something through together, discuss it in chat");
        expect(system).toContain(RESTATE_RULE.slice(2));
        expect(system).toContain("怪怪的, 為什麼, 看不懂");
        expect(system).toContain("goes into one Markdown file instead");
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
