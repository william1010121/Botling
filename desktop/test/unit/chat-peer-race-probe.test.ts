// @vitest-environment jsdom
// M7-06a review probe: a peer bot's chat/link buttons (M5-09) through the chat plugin's slot during a switch-to-peer / switch-back
// race and a late view update (the feed holds an older list than the one the chat is drawn from).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView, PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CHAT_PLUGIN } from "../../src/renderer/chat-names";
import { chatPlugins } from "../../src/renderer/chat-slot";
import { withOwnerLinkMenus } from "../../src/main-v3/peer-link-menu";
import { chatState } from "../../src/renderer/payload";
import { rendererKernel, subscribeSlots } from "../../src/renderer/renderer-kernel";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const chatOnly = { plugins: manifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) };
const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const chat = { botId: "B", messages: [], running: null, live: [] };
const buttons = (view: PluginsView) => (chatState(bot, chat, new Date(Date.UTC(2026, 10, 16)), null, { plugins: chatPlugins(view), lang: null }).state.linkMenu ?? []).map((entry) => entry.command);
const link = (plugin: string, command: string) => ({ menu: "chat/link" as const, command, plugin, title: "開始陪讀", when: { ext: ["pdf"] } });
const FULL: PluginsView = { plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, menus: [link("coach", "coach.start"), link("reader", "reader.open"), { menu: "composer/plus", command: "coach.note", plugin: "coach", title: "Note" }] };
const ownerRow = { codeHash: "sha256:" + "bb".repeat(32), manifest: { tier: "request", reads: [], requests: ["plugins.linkCommand"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] }, author: "user", grants: {} };
const PEER = withOwnerLinkMenus(FULL, new Map([["plugin:coach", ownerRow]]));
const PEER_NONE = withOwnerLinkMenus(FULL, null);
const links = (n: number) => vi.waitFor(() => { expect(rendererKernel.entries("chat/link")).toHaveLength(n); });

const hosts: InPageHost[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  reconcileView(null);
});
async function up() { const one = new InPageHost({ manifest: chatOnly, log: () => undefined }); hosts.push(one); await one.start(); }

describe("peer chat/link through the slot, switch race", () => {
  it("switch to the peer before the feed catches up: the reader button the owner lacks is never shown", async () => {
    await up();
    reconcileView(FULL);
    await links(2);
    expect(buttons(FULL)).toEqual(["coach.start", "reader.open"]);
    // The adapter's filtered view reached the store; the feed (ShellFrame effect) has not run yet: slot still holds both.
    expect(buttons(PEER)).toEqual(["coach.start"]);
    expect(buttons(PEER_NONE)).toEqual([]);
    reconcileView(PEER);
    await links(1);
    expect(buttons(PEER)).toEqual(["coach.start"]);
  });

  it("switch back: a button the slot does not hold yet is not shown early, a slot listener fires once the feed catches up, then it is", async () => {
    await up();
    reconcileView(PEER);
    await links(1);
    expect(buttons(FULL)).toEqual(["coach.start"]);
    let told = 0;
    const off = subscribeSlots(() => { told += 1; });
    reconcileView(FULL);
    await links(2);
    await vi.waitFor(() => { expect(told).toBeGreaterThan(0); });
    off();
    expect(buttons(FULL)).toEqual(["coach.start", "reader.open"]);
  });

  it("a late view update after the switch (the feed reconciles the full list while the peer's chat is shown) does not bring the reader back", async () => {
    await up();
    reconcileView(PEER);
    await links(1);
    reconcileView(FULL);
    await links(2);
    expect(buttons(PEER)).toEqual(["coach.start"]);
    expect(buttons(PEER_NONE)).toEqual([]);
    // Back and forth quickly: the slot ends on the last list, the buttons always follow the shown view.
    reconcileView(PEER_NONE); reconcileView(FULL); reconcileView(PEER);
    await links(1);
    expect(buttons(PEER_NONE)).toEqual([]);
    expect(buttons(FULL)).toEqual(["coach.start"]);
  });
});
