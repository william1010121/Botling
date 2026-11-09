// A script or monitor a bot starts can wake it: the app rereads routines.cron every 30 s, so a script appends an
// every-minute line on an event and the bot deletes it first thing. The prompt says so, so a bot never claims a
// background script cannot wake it (swordgale, 2026-11-09).
import { describe, expect, it } from "vitest";
import { botPrompts, desktopPrompts } from "../../src/core/prompts";

const profile = (role: "main" | "manager" | "bot") => ({ id: `${role}-id`, name: "P", role, folder: "/p/repo", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: null, instructions: null });
const system = (engine: "claude" | "codex" | "agy", role: "main" | "manager" | "bot" = "manager") =>
  desktopPrompts(botPrompts({ profile: profile(role), engine, language: "en" }), profile(role), engine).system;

const LINE = (file: string) => `A script or monitor you start can wake you by appending the line "@once Alert: what happened" to ${file}; the app runs it once at its next check and removes the line.`;

describe("a script can wake the bot", () => {
  it("tells a Claude bot, in one sentence right after the legacy routines rule, with the full path", () => {
    const text = system("claude");
    expect(text).toContain(`this legacy file for recurring jobs; Codex uses app_routines instead. Never encode a one-time request as a yearly cron job. For one-time scheduling on Claude, use the app’s Routines settings. Say what changed only after it is saved.\n  ${LINE("/p/repo/.bot/routines.cron")}\n`);
    expect(text).not.toMatch(/delete that line first|after 3 minutes/);
  });
  it("gives the main bot its own routines.cron path", () => {
    expect(system("claude", "main")).toContain(LINE("/p/repo/routines.cron"));
  });
  it("tells Codex and Antigravity bots the same sentence: their routines.cron runs too", () => {
    expect(system("codex")).toContain(`  ${LINE("/p/repo/.bot/routines.cron")}`);
    expect(system("agy")).toContain(`\n${LINE("/p/repo/.bot/routines.cron")}`);
  });
});
