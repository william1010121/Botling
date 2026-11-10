// Routines in the prompt. Every engine's coordinator has app_routines (2026-11-11), so every bot is told the same rule:
// use app_routines; the legacy routines.cron still runs and may still be edited, but the tool comes first. A script or
// monitor a bot starts can still wake it with a one-shot "@once Alert" line in routines.cron (swordgale, 2026-11-09).
import { describe, expect, it } from "vitest";
import { botPrompts, desktopPrompts, routinesRule } from "../../src/core/prompts";

const profile = (role: "main" | "manager" | "bot") => ({ id: `${role}-id`, name: "P", role, folder: "/p/repo", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: null, instructions: null });
const system = (engine: "claude" | "codex" | "agy", role: "main" | "manager" | "bot" = "manager") =>
  desktopPrompts(botPrompts({ profile: profile(role), engine, language: "en" }), profile(role), engine).system;

const LINE = (file: string) => `A script or monitor you start can wake you by appending the line "@once Alert: what happened" to ${file}; the app runs it once at its next check and removes the line.`;

describe("the routines rule", () => {
  it("tells every engine the same rule: app_routines first, routines.cron still readable", () => {
    for (const engine of ["claude", "codex", "agy"] as const) {
      const text = system(engine);
      expect(text).toContain(routinesRule("/p/repo/.bot/routines.cron"));
      expect(text).not.toMatch(/On Codex, use app_routines|Codex uses app_routines instead|For one-time scheduling on Claude/);
    }
    const rule = routinesRule("/p/repo/.bot/routines.cron");
    expect(rule).toMatch(/^- Routines: [^\n]*app_routines/);
    expect(rule).toContain("kind=watch");
    expect(rule).toContain("prefer app_routines");
  });
  it("keeps the @once Alert line for scripts, with the full path", () => {
    expect(system("claude")).toContain(`  ${LINE("/p/repo/.bot/routines.cron")}\n`);
    expect(system("codex")).toContain(`  ${LINE("/p/repo/.bot/routines.cron")}`);
    expect(system("agy")).toContain(`  ${LINE("/p/repo/.bot/routines.cron")}`);
    expect(system("claude", "main")).toContain(LINE("/p/repo/routines.cron"));
  });
});
