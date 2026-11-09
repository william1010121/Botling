// A script or monitor a bot starts can wake it: the app rereads routines.cron every 30 s, so a script appends an
// every-minute line on an event and the bot deletes it first thing. The prompt says so, so a bot never claims a
// background script cannot wake it (swordgale, 2026-11-09).
import { describe, expect, it } from "vitest";
import { botPrompts, desktopPrompts } from "../../src/core/prompts";

const profile = (role: "main" | "manager" | "bot") => ({ id: `${role}-id`, name: "P", role, folder: "/p/repo", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: null, instructions: null });
const system = (engine: "claude" | "codex" | "agy", role: "main" | "manager" | "bot" = "manager") =>
  desktopPrompts(botPrompts({ profile: profile(role), engine, language: "en" }), profile(role), engine).system;

describe("a script can wake the bot", () => {
  it("tells a Claude bot to have its script append a routines.cron line, with the full path, and remove it once woken", () => {
    const text = system("claude");
    expect(text).toContain("A script or monitor you start can wake you:");
    expect(text).toContain("/p/repo/.bot/routines.cron");
    expect(text).toMatch(/delete that line first/);
    // Right after the legacy routines rule.
    expect(text.indexOf("A script or monitor you start")).toBeGreaterThan(text.indexOf("Claude may edit this legacy file"));
  });
  it("gives the main bot its own routines.cron path", () => {
    expect(system("claude", "main")).toContain("/p/repo/routines.cron");
  });
  it("tells a Codex bot to cancel the line with app_routines", () => {
    const text = system("codex");
    expect(text).toContain("A script or monitor you start can wake you:");
    expect(text).toMatch(/app_routines cancel/);
  });
  it("leaves Antigravity's prompt, which has no routines rule, alone", () => {
    expect(system("agy")).not.toContain("A script or monitor you start");
  });
});
