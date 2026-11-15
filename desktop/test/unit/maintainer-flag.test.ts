// M5-04h: Core marks Maintainer on BotView (`maintainer: true`) and renderer uses `isMaintainer` / `role === "main"` instead of fixed id constants.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Core, type CoreOptions } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { BotView, MAINTAINER_BOT_ID, isMaintainer, type Event, type Outbound } from "../../src/contract";
import { resolveBotColors } from "../../src/renderer/avatars";
import { mentionNames } from "../../src/renderer/payload";
import { canIdle, railSplit } from "../../src/renderer/rail-idle";
import { SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";
import { fakeCli, tempDir } from "../helpers";

const CUSTOM_MAIN = "0F0F0000-0000-4000-8000-000000000011";
const CUSTOM_MAINTAINER = "0F0F0000-0000-4000-8000-000000000022";

const openCores: Core[] = [];

afterEach(async () => {
  for (const core of openCores.splice(0)) {
    await core.shutdown().catch(() => {});
  }
});

function createCore(dir: string, extra: Partial<CoreOptions> = {}) {
  const outbound: Outbound[] = [];
  const base = coreProcessOptions({
    env: {
      BOTLING_AGENT: "fake",
      BOTLING_FAKE_CLI: fakeCli,
      BOTLING_COMPONENT_SCAN_MS: "0",
      BOTLING_WAITING_SCAN_MS: "0",
      BOTLING_ROUTINE_TICK_MS: "0",
      BOTLING_WATCH_MS: "0",
      BOTLING_QUIT_TIDY_MS: "0",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    dataDir: dir,
    outDir: join(dir, "unused-out"),
    emit: (message) => outbound.push(message),
    log: () => {},
    node: null,
    sealer: null,
    app: null,
  });
  const core = new Core({
    ...base,
    plugins: null,
    ...extra,
  });
  openCores.push(core);
  return { core, outbound };
}

const makeView = (over: Partial<BotView> & { id: string }): BotView => ({
  name: over.id,
  role: "bot",
  avatar: "square",
  folder: "/w",
  phase: "awake",
  working: false,
  approvals: 0,
  unread: 0,
  subagents: 0,
  problem: null,
  heads: ["claude"],
  job: null,
  subagentRows: [],
  ...over,
});

describe("M5-04h: Maintainer flag on BotView and isMaintainer", () => {
  it("sets maintainer: true on the BotView matching CoreOptions.maintainerId and on no other bot", () => {
    const dir = tempDir("maintainer-flag-custom");
    const { core, outbound } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });

    const snap = core.snapshot();
    const flagged = snap.bots.filter((bot) => bot.maintainer === true);
    expect(flagged.map((bot) => bot.id)).toEqual([CUSTOM_MAINTAINER]);
    for (const bot of snap.bots) {
      expect(BotView.safeParse(bot).success).toBe(true);
      if (bot.id !== CUSTOM_MAINTAINER) {
        expect(bot.maintainer).toBeUndefined();
      }
    }
    expect(core.serverBotView(CUSTOM_MAINTAINER)?.maintainer).toBe(true);
    expect(core.serverBotView(CUSTOM_MAIN)?.maintainer).toBeUndefined();
    expect(BotView.safeParse({ ...flagged[0]!, maintainer: false }).success).toBe(false);

    // bot.updated emitted for the Maintainer also carries maintainer: true; other bots omit it.
    const maintainerBot = (core as any).bots.get(CUSTOM_MAINTAINER);
    const mainBot = (core as any).bots.get(CUSTOM_MAIN);
    maintainerBot.refresh();
    mainBot.refresh();
    const updatedEvents = outbound
      .filter((m): m is Extract<Outbound, { event: Event }> & { event: Extract<Event, { type: "bot.updated" }> } => "event" in m && m.event.type === "bot.updated")
      .map((m) => m.event.bot);
    const maintainerEvent = updatedEvents.findLast((b) => b.id === CUSTOM_MAINTAINER);
    const mainEvent = updatedEvents.findLast((b) => b.id === CUSTOM_MAIN);
    expect(maintainerEvent?.maintainer).toBe(true);
    expect(mainEvent?.maintainer).toBeUndefined();
  });

  it("sets maintainer: true on the default 2.x Maintainer id when maintainerId is not overridden", () => {
    const dir = tempDir("maintainer-flag-default");
    const { core } = createCore(dir);

    const flagged = core.snapshot().bots.filter((bot) => bot.maintainer === true);
    expect(flagged.map((bot) => bot.id)).toEqual([MAINTAINER_BOT_ID]);
  });

  it("isMaintainer matches the maintainer: true flag and the 2.x constant fallback, and rejects others", () => {
    expect(isMaintainer({ id: CUSTOM_MAINTAINER, maintainer: true })).toBe(true);
    expect(isMaintainer({ id: MAINTAINER_BOT_ID })).toBe(true);
    expect(isMaintainer({ id: CUSTOM_MAINTAINER })).toBe(false);
    expect(isMaintainer({ id: CUSTOM_MAIN })).toBe(false);
  });
});

describe("M5-04h: renderer pure logic uses maintainer flag and role === main", () => {
  const customMain = makeView({ id: CUSTOM_MAIN, name: "Main bot", role: "main", avatar: "circle" });
  const customKeeper = makeView({ id: CUSTOM_MAINTAINER, name: "Maintainer", role: "manager", avatar: "diamond", maintainer: true });
  const projA = makeView({ id: "11111111-1111-4111-8111-111111111111", name: "alpha", role: "manager", avatar: "square" });
  // Lexicographically earlier than CUSTOM_MAINTAINER so only ranking Maintainer before regular bots preserves its diamond purple.
  const botB = makeView({ id: "00000000-0000-4000-8000-000000000001", name: "beta", role: "bot", avatar: "diamond" });

  it("rail-idle treats a flagged bot with a random id as Maintainer", () => {
    expect(canIdle(customMain)).toBe(false);
    expect(canIdle(customKeeper)).toBe(false);
    expect(canIdle(projA)).toBe(true);

    const split = railSplit([projA, customKeeper, customMain, botB], [botB.id, CUSTOM_MAINTAINER], [CUSTOM_MAINTAINER, projA.id]);
    expect(split.rows.map((entry) => [entry.bot.id, entry.section])).toEqual([
      [CUSTOM_MAIN, null],
      [CUSTOM_MAINTAINER, null],
      [botB.id, "pinned"],
    ]);
    expect(split.idle.map((bot) => bot.id)).toEqual([projA.id]);
  });

  it("resolveBotColors ranks a flagged Maintainer with a random id right after main", () => {
    // botB also uses "diamond"; Maintainer goes second and keeps diamond's purple while botB moves.
    const colors = resolveBotColors([botB, customKeeper, customMain]);
    expect(colors.get(CUSTOM_MAINTAINER)).toBe("#9B5CF0");
    expect(colors.get(botB.id)).not.toBe("#9B5CF0");
  });

  it("mentionNames offers a custom-id main bot and flagged Maintainer first", () => {
    const result = mentionNames(projA, [projA, botB, customKeeper, customMain]);
    expect(result.mentions).toEqual(["Maintainer", "Main bot"]);
    expect(result.allMentions).toEqual(["Maintainer", "Main bot", "beta"]);
  });

  it("Settings Developer project picker excludes a flagged Maintainer with role manager", () => {
    const html = renderToStaticMarkup(createElement(SettingsSheet, {
      client: { request: async () => ({}) } as unknown as Client,
      settings: {
        language: null,
        effectiveLanguage: "en",
        stallMinutes: 15,
        pinnedBots: [],
        idleBots: [],
        botColors: {},
        developerMode: true,
        developerProject: null,
        claudeWorkers: "managed",
        claudeMaxWorkers: null,
        claudePermissions: "acceptEdits",
        codexPermissions: "full",
        agyPermissions: "full",
        engineDefaults: {},
        chatAvatarSize: null,
        look: "original",
        shortcuts: {},
        autoMode: false,
        collapseLongPaste: true,
        collapseLongPasteLines: 8,
        agyRuntimeDir: null,
      } as never,
      bot: null,
      bots: [customMain, customKeeper, projA],
      plugins: null,
      initialSection: "developer",
      onClose: () => {},
    }));
    expect(html).toContain(projA.id);
    expect(html).not.toContain(CUSTOM_MAINTAINER);
  });
});
