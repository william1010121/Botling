// M5-04f: Core takes its main bot and Maintainer ids from CoreOptions (default: the 2.x constants).
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core, type CoreOptions } from "../../src/core/server";
import { coreProcessOptions } from "../../src/core/core-process";
import { maintainerEditorBinding } from "../../src/core/agent/component-editor";
import { maintainerProfile } from "../../src/core/maintainer";
import { saveProjectRow } from "../../src/core/projects";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../src/core/store/records";
import { loadProfiles, mainProfile } from "../../src/core/store/workspace";
import { PROTOCOL_VERSION, type Outbound } from "../../src/contract";
import { fakeCli, tempDir, until } from "../helpers";

const CUSTOM_MAIN = "0F0F0000-0000-4000-8000-000000000001";
const CUSTOM_MAINTAINER = "0F0F0000-0000-4000-8000-000000000002";

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

async function call(core: Core, outbound: Outbound[], cmd: unknown, id = `req-${Math.random().toString(36).slice(2)}`) {
  core.receive({ v: PROTOCOL_VERSION, id, cmd });
  const response = await until(() =>
    outbound.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === id),
  );
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as any;
}

describe("M5-04f: core fixed ids from CoreOptions", () => {
  it("lists main bot (role main) and Maintainer (role manager) under custom ids, and nothing under the 2.x constants", () => {
    const dir = tempDir("fixed-ids-list");
    const { core } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });

    expect(core.mainBotId).toBe(CUSTOM_MAIN);
    expect(core.maintainerId).toBe(CUSTOM_MAINTAINER);
    expect(core.mainBot()?.id).toBe(CUSTOM_MAIN);

    const snapshot = core.snapshot();
    const ids = snapshot.bots.map((bot) => bot.id);
    expect(ids).toContain(CUSTOM_MAIN);
    expect(ids).toContain(CUSTOM_MAINTAINER);
    expect(ids).not.toContain(MAIN_BOT_ID);
    expect(ids).not.toContain(MAINTAINER_ID);

    expect(snapshot.bots.find((bot) => bot.id === CUSTOM_MAIN)?.role).toBe("main");
    expect(snapshot.bots.find((bot) => bot.id === CUSTOM_MAINTAINER)?.role).toBe("manager");

    // Plugin world bots.list maps the custom main id to "main" and keeps the custom Maintainer id.
    const worldBots = (core as any).plugins.options.world.bots();
    expect(worldBots.map((b: any) => b.id)).toContain("main");
    expect(worldBots.map((b: any) => b.id)).toContain(CUSTOM_MAINTAINER);
    expect(worldBots.map((b: any) => b.id)).not.toContain(MAIN_BOT_ID);
    expect(worldBots.map((b: any) => b.id)).not.toContain(MAINTAINER_ID);
  });

  it("routes a command naming 'main' to the bot with the given mainBotId", async () => {
    const dir = tempDir("fixed-ids-main-alias");
    const { core, outbound } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });

    const snap = await call(core, outbound, { type: "chat.snapshot" });
    expect(snap.chat.botId).toBe(CUSTOM_MAIN);

    const world = (core as any).plugins.options.world;
    expect(world.botId("main")).toBe(CUSTOM_MAIN);
    const beforeCount = world.routinesList("main")?.routines.length ?? 0;
    expect(world.addRoutine("main", "0 9 * * *", "Daily check")).toBe("added");
    const routines = world.routinesList("main")?.routines ?? [];
    expect(routines).toHaveLength(beforeCount + 1);
    expect(routines.some((r: any) => r.task === "Daily check")).toBe(true);
    const sent = world.send("main", "hello main", null);
    expect(sent.messageId).toBeTruthy();
    const pluginChat = world.chat("main", 10);
    expect(pluginChat.botId).toBe("main");
    expect(pluginChat.messages.some((m: any) => m.text === "hello main")).toBe(true);
  });

  it("delivers inbox.md via deliverInboxes and lists main bot open questions under the given mainBotId in waiting()", async () => {
    const dir = tempDir("fixed-ids-inbox-waiting");
    const projectDir = tempDir("fixed-ids-project");
    mkdirSync(join(projectDir, ".bot"), { recursive: true });
    const projectId = "11111111-1111-4111-8111-111111111111";
    saveProjectRow(dir, { id: projectId, name: "worker-proj", folder: projectDir, avatar: "triangle" });

    const { core } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });

    // 1. deliverInboxes delivers inbox.md to the project bot and empties it.
    const inboxFile = join(projectDir, ".bot", "inbox.md");
    writeFileSync(inboxFile, "Please check status");
    core.deliverInboxes();
    expect(readFileSync(inboxFile, "utf8")).toBe("");
    const projectBot = (core as any).bots.get(projectId);
    expect(projectBot.lines().some((line: any) => line.text?.includes("Please check status"))).toBe(true);

    // Also verify main bot's replied() triggers deliverInboxes() using the custom mainBotId.
    writeFileSync(inboxFile, "Second inbox note");
    (core as any).replied(core.mainBot()!, { id: "r1", role: "bot", text: "done", date: 0 });
    expect(readFileSync(inboxFile, "utf8")).toBe("");

    // 2. Open question on main bot appears under CUSTOM_MAIN in waiting().
    core.mainBot()!.appNotice("Proceed now?", [{ label: "Yes" }, { label: "No" }]);
    const waiting = core.waiting();
    expect(waiting.items.some((item) => item.botId === CUSTOM_MAIN && item.text.includes("Proceed now?"))).toBe(true);
    expect(waiting.items.some((item) => item.botId === MAIN_BOT_ID)).toBe(false);
  });

  it("honours <new-bot> from the given maintainerId and ignores it from any other bot", async () => {
    const dir = tempDir("fixed-ids-new-bot");
    const projectDir = tempDir("fixed-ids-proj-nb");
    mkdirSync(join(projectDir, ".bot"), { recursive: true });
    const otherId = "22222222-2222-4222-8222-222222222222";
    saveProjectRow(dir, { id: otherId, name: "regular", folder: projectDir, avatar: "triangle" });

    const { core } = createCore(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });
    const botsMap = (core as any).bots as Map<string, any>;
    const maintainerBot = botsMap.get(CUSTOM_MAINTAINER)!;
    const otherBot = botsMap.get(otherId)!;

    // From custom Maintainer: honoured.
    (core as any).projectRequests(maintainerBot, [{ kind: "newBot", name: "Helper", job: "Assist with builds" }]);
    await until(() => core.snapshot().bots.some((bot) => bot.name === "Helper"));
    expect(core.mainBot()!.lines().some((line) => line.text.includes('New bot "Helper"'))).toBe(true);

    // From another bot: left out.
    (core as any).projectRequests(otherBot, [{ kind: "newBot", name: "Unauthorized", job: "Should not be created" }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(core.snapshot().bots.some((bot) => bot.name === "Unauthorized")).toBe(false);
  });

  it("supports custom ids in workspace helpers and maintainerEditorBinding, and handles null mainBot cleanly", async () => {
    const dir = tempDir("fixed-ids-helpers");
    const profile = mainProfile(dir, CUSTOM_MAIN);
    expect(profile.id).toBe(CUSTOM_MAIN);

    // loadProfiles passes custom ids and filters custom maintainerId if present in projects.json.
    saveProjectRow(dir, { id: CUSTOM_MAINTAINER, name: "FakeMaintainer", folder: dir, avatar: "diamond" });
    const loaded = loadProfiles(dir, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });
    expect(loaded.profiles.map((p) => p.id)).toEqual([CUSTOM_MAIN]);

    // maintainerEditorBinding binds to the custom maintainerId.
    const owner = maintainerProfile(dir, "instructions", CUSTOM_MAINTAINER);
    expect(owner.id).toBe(CUSTOM_MAINTAINER);
    const binding = maintainerEditorBinding(owner, dir, () => ({ command: "claude", cwd: join(dir, "plugins"), sessionId: "s", resume: false, allowedTools: [] }), CUSTOM_MAINTAINER);
    const route = binding(owner, { sessionId: "s", resume: false } as any);
    expect(route).not.toBeNull();

    // Default options fall back to 2.x constants.
    const defDir = tempDir("fixed-ids-default");
    const { core: defCore } = createCore(defDir);
    expect(defCore.mainBotId).toBe(MAIN_BOT_ID);
    expect(defCore.maintainerId).toBe(MAINTAINER_ID);
    expect(defCore.mainBot()?.id).toBe(MAIN_BOT_ID);

    // Protected removal + null mainBot handling.
    const dir2 = tempDir("fixed-ids-remove");
    const projectDir = tempDir("fixed-ids-proj-null");
    mkdirSync(join(projectDir, ".bot"), { recursive: true });
    const otherId = "33333333-3333-4333-8333-333333333333";
    saveProjectRow(dir2, { id: otherId, name: "other", folder: projectDir, avatar: "triangle" });
    const { core } = createCore(dir2, { mainBotId: CUSTOM_MAIN, maintainerId: CUSTOM_MAINTAINER });
    await expect(core.removeBot(CUSTOM_MAIN)).rejects.toThrow(/cannot be removed/);
    await expect(core.removeBot(CUSTOM_MAINTAINER)).rejects.toThrow(/cannot be removed/);

    // Simulate absent main bot (M5-04i preparation): null paths do not throw.
    (core as any).bots.delete(CUSTOM_MAIN);
    (core as any).order = (core as any).order.filter((id: string) => id !== CUSTOM_MAIN);
    expect(core.mainBot()).toBeNull();
    expect(core.snapshot().chat).toBeNull();
    expect(core.waiting().items).toEqual([]);
    const world = (core as any).plugins.options.world;
    expect(await world.ask({ text: "Pick?", choices: [{ label: "A" }, { label: "Cancel" }], typed: false })).toEqual({ index: 1 });
    expect(await world.app.card("Hi", [{ label: "OK" }])).toBeNull();
    await expect(core.removeBot(otherId)).resolves.toEqual({ removed: true });
  });
});
