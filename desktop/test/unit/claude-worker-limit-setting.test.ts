// @vitest-environment jsdom
// Settings → Engines → Claude subagents: "Claude workers at once" (settings.json `claudeWorkerLimit`, 1–16, default 4).
// It is saved like every other setting, and a bot reads it again for each worker, so a change reaches the next worker
// that starts without a restart. Lowering it stops nothing that is at work; raising it lets waiting workers start.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsChange, SettingsView } from "../../src/contract";
import { applySetting, launchSettings, readSettings, settingsView, writeSettings } from "../../src/core/settings";
import { SettingsSheet } from "../../src/renderer/Settings";
import { workerLimitWords } from "../../src/renderer/worker-limit-text";
import type { Client } from "../../src/renderer/client";
import { claudeHarness } from "../claude-workers-fake";

const harnesses: ReturnType<typeof claudeHarness>[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) await h.workers.close(); });

describe("the Claude worker limit setting", () => {
  it("shows 4 when unset and round-trips through settings.json", () => {
    expect(settingsView({}).claudeWorkerLimit).toBe(4);
    const raw = applySetting({}, { key: "claudeWorkerLimit", value: 8 });
    expect(raw.claudeWorkerLimit).toBe(8);
    expect(settingsView(raw).claudeWorkerLimit).toBe(8);
    expect(launchSettings(raw).claudeWorkerLimit).toBe(8);
    expect(SettingsView.parse(settingsView(raw)).claudeWorkerLimit).toBe(8);
    // null: back to the default (the key goes).
    expect("claudeWorkerLimit" in applySetting(raw, { key: "claudeWorkerLimit", value: null })).toBe(false);
    // A hand-edited bad value shows as settings.ts reads it.
    expect(settingsView({ claudeWorkerLimit: 99 }).claudeWorkerLimit).toBe(16);
    expect(settingsView({ claudeWorkerLimit: 0 }).claudeWorkerLimit).toBe(4);
  });

  it("only whole numbers from 1 to 16 cross the command boundary", () => {
    for (const value of [1, 16, null]) expect(SettingsChange.safeParse({ key: "claudeWorkerLimit", value }).success).toBe(true);
    for (const value of [0, 17, 2.5, "4", NaN]) expect(SettingsChange.safeParse({ key: "claudeWorkerLimit", value }).success).toBe(false);
  });

  it("a changed limit reaches the next worker without a restart and stops nothing at work", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "botling-worker-limit-")), "settings.json");
    const set = (value: number) => writeSettings(file, applySetting(readSettings(file), { key: "claudeWorkerLimit", value }));
    set(1);
    // As the server wires it: settings.json is read again each time the limit is asked.
    const h = claudeHarness(undefined, { maxRunning: () => launchSettings(readSettings(file)).claudeWorkerLimit });
    harnesses.push(h);
    await h.workers.tool("app_handoff", { instructions: "A" });
    await h.workers.tool("app_handoff", { instructions: "B" });
    expect(h.heads).toHaveLength(1);

    // Raised: the next handoff lets the one waiting start first, then waits itself.
    set(2);
    await h.workers.tool("app_handoff", { instructions: "C" });
    expect(h.heads.map((head) => head.sent[0]!.text)).toEqual(["A", "B"]);

    // Raised again, from Settings: a waiting worker starts at once.
    set(3);
    h.workers.slotsChanged();
    expect(h.heads.map((head) => head.sent[0]!.text)).toEqual(["A", "B", "C"]);

    // Lowered: nothing at work is stopped; a new one waits until enough have finished.
    set(1);
    await h.workers.tool("app_handoff", { instructions: "D" });
    expect(h.heads.some((head) => head.terminated)).toBe(false);
    expect(h.heads).toHaveLength(3);
    h.result(h.heads[0]!, "A done.");
    h.result(h.heads[1]!, "B done.");
    expect(h.heads).toHaveLength(3);
    h.result(h.heads[2]!, "C done.");
    expect(h.heads).toHaveLength(4);
    expect(h.heads[3]!.sent[0]!.text).toBe("D");
  });
});

describe("the Settings row", () => {
  it("has English and Traditional Chinese words", () => {
    expect(workerLimitWords("en")).toMatchObject({ label: "Claude workers at once", hint: expect.stringContaining("Codex and Antigravity workers are not limited") });
    expect(workerLimitWords("zh-Hant").label).not.toBe(workerLimitWords("en").label);
    expect(workerLimitWords(null)).toBe(workerLimitWords("en"));
  });

  it("shows the current limit in Engines and saves a new one", async () => {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const changes: unknown[] = [];
    const client = { request: async (cmd: any) => {
      if (cmd.type === "settings.set") { changes.push(cmd.change); return settingsView(applySetting({}, cmd.change)); }
      return { models: [] };
    } } as unknown as Client;
    try {
      await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({}), bot: null, plugins: null, initialSection: "engines", onClose() {} })));
      const select = host.querySelector<HTMLSelectElement>('select[aria-label="Claude workers at once"]')!;
      expect(select).not.toBeNull();
      expect(select.value).toBe("4");
      expect([...select.options].map((option) => Number(option.value))).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      expect(host.textContent).toContain("Codex and Antigravity workers are not limited");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "6");
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(changes).toEqual([{ key: "claudeWorkerLimit", value: 6 }]);
    } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
  });

  it("is in Traditional Chinese when the app is", async () => {
    const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const client = { request: async () => ({ models: [] }) } as unknown as Client;
    try {
      await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({ languageChoice: "zh-Hant", claudeWorkerLimit: 2 }), bot: null, plugins: null, initialSection: "engines", onClose() {} })));
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${workerLimitWords("zh-Hant").label}"]`)!;
      expect(select.value).toBe("2");
    } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
  });
});
