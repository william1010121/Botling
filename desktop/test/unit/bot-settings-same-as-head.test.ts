// @vitest-environment jsdom
// The bot settings page says whose settings they are, and "Same as head" names the head's model and effort that the
// bot's workers then run on (the Workers tab lists the parent's and sibling sub bots' workers next to them, so a page
// that only said "Settings" and "Same as head" read as the settings of the worker you were looking at).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { sameAsHead } from "../../src/renderer/bot-defaults";
import type { BotSettingsView, BotView } from "../../src/contract";

const bot = { id: "math", name: "Math", role: "main", heads: ["claude"], phase: "awake", working: false, approvals: 0, unread: 0, avatar: "star", subagentRows: [] } as unknown as BotView;
const view = (extra: Partial<BotSettingsView>) => ({ botId: "b", engines: ["claude"], primary: null, primaryEffective: "claude", model: null, effort: null, efforts: {}, subagentModel: null, subagentEffort: null, codexModel: null, agyModel: null, codexWorkers: null, agyWorkerModel: null, agyWorkerEffort: null, ...extra }) as unknown as BotSettingsView;

describe("Same as head", () => {
  it("names the head's own model and effort", () => {
    const v = view({ model: "opus", efforts: { claude: "medium" } as BotSettingsView["efforts"] });
    expect(sameAsHead(v, "claude", "workerModel")).toBe("Same as head (Opus)");
    expect(sameAsHead(v, "claude", "workerModel", (id) => (id === "opus" ? "Opus 5.5" : null))).toBe("Same as head (Opus 5.5)");
    expect(sameAsHead(v, "claude", "workerEffort")).toBe("Same as head (Medium)");
  });
  it("with no head choice of its own, names the engine's default", () => {
    expect(sameAsHead(view({}), "claude", "workerModel")).toBe("Same as head (Claude default)");
    expect(sameAsHead(view({}), "claude", "workerEffort")).toBe("Same as head (Default)");
    expect(sameAsHead(view({ effort: "high" }), "claude", "workerEffort")).toBe("Same as head (High)");
    expect(sameAsHead(view({ codexModel: "gpt-6" }), "codex", "workerModel")).toBe("Same as head (gpt-6)");
  });
});

describe("the settings page's header", () => {
  it("names the bot whose settings these are", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const props = {
      bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status: { key: "idle", text: "Idle" }, results: [], watching: null, collapsed: false,
      onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onCloseSettings() {}, onExpand() {},
      showingSettings: true, settingsPage: createElement("div", null, "page"),
    } as unknown as RightPanelProps;
    await act(async () => root.render(createElement(RightPanel, props)));
    try {
      expect(host.querySelector(".detail-head")!.textContent).toBe("Math settings");
    } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
  });
});
