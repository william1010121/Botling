import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsChange, SettingsView } from "../../src/contract";
import { applySetting, launchSettings, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { headArguments } from "../../src/core/agent/head";

const base = { command: "claude", cwd: "/tmp", sessionId: "session", resume: false, allowedTools: ["Read"] };
const mode = (args: string[]) => args[args.indexOf("--permission-mode") + 1];

describe("independent engine permission settings", () => {
  it("keeps legacy defaults and rejects malformed opt-ins", () => {
    for (const raw of [{}, { claudeBypassPermissions: "true", codexBypassPermissions: 1 }]) {
      expect(launchSettings(raw)).toMatchObject({ autoMode: true, claudeBypassPermissions: false, codexBypassPermissions: false });
      expect(settingsView(raw)).toMatchObject({ claudeBypassPermissions: false, codexBypassPermissions: false });
    }
    expect(launchSettings({ autoApprove: false }).autoMode).toBe(false);
    expect(SettingsChange.safeParse({ key: "codexBypassPermissions", value: "true" }).success).toBe(false);
    const { claudeBypassPermissions, codexBypassPermissions, ...legacy } = settingsView({});
    expect(SettingsView.parse(legacy)).toMatchObject({ claudeBypassPermissions: false, codexBypassPermissions: false });
  });

  it("persists independent toggles and retains previous auto mode plus unknown settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-permissions-"));
    const file = join(dir, "settings.json");
    try {
      let raw = { autoApprove: false, futureKey: "retained" } as Record<string, unknown>;
      for (const key of ["claudeBypassPermissions", "codexBypassPermissions"] as const) {
        raw = applySetting(raw, SettingsChange.parse({ key, value: true }));
        writeSettings(file, raw);
        expect(launchSettings(readSettings(file))[key]).toBe(true);
      }
      raw = applySetting(readSettings(file), { key: "claudeBypassPermissions", value: false });
      writeSettings(file, raw);
      expect(launchSettings(readSettings(file))).toMatchObject({ autoMode: false, claudeBypassPermissions: false, codexBypassPermissions: true });
      expect(readSettings(file).futureKey).toBe("retained");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([false, true])("sets explicit Claude permission mode on new/resumed sessions (resume=%s)", (resume) => {
    expect(mode(headArguments({ ...base, resume, autoMode: true, bypassPermissions: true }))).toBe("bypassPermissions");
    expect(mode(headArguments({ ...base, resume, autoMode: true, bypassPermissions: false }))).toBe("auto");
    expect(mode(headArguments({ ...base, resume, autoMode: false }))).toBe("acceptEdits");
    expect(mode(headArguments({ ...base, resume, harmless: true, bypassPermissions: true }))).toBe("default");
  });
});


describe("Claude auto risk policy launch settings", () => {
  it.each([false, true])("sends low/medium allow and high/unknown checkpoint rules with defaults on resume=%s", (resume) => {
    const args = headArguments({ ...base, resume, autoMode: true, allowRules: ["Bash(echo ok)"] });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.permissions.allow).toEqual(["Bash(echo ok)"]);
    expect(settings.autoMode.allow[0]).toBe("$defaults");
    for (const risk of ["low", "medium"]) expect(settings.autoMode.allow.some((rule: string) => rule.startsWith(`Botling ${risk} risk (allow):`))).toBe(true);
    expect(settings.autoMode.soft_deny[0]).toBe("$defaults");
    for (const risk of ["high", "unknown"]) expect(settings.autoMode.soft_deny.some((rule: string) => rule.startsWith(`Botling ${risk} risk (ask):`))).toBe(true);
    expect(settings.autoMode.hard_deny).toBeUndefined(); // keep the engine/managed hard denies
    expect(settings.autoMode.environment.join(" ")).toContain("sandbox failure is not a risk classification");
  });

  it.each([{ autoMode: false }, { autoMode: true, bypassPermissions: true }, { autoMode: true, harmless: true }])("does not inject auto policy for %j", (config) => {
    expect(headArguments({ ...base, ...config })).not.toContain("--settings");
  });
});
