// M6-09: Rollback to 2.x at any time (check).
// Proves that after an import and active use of Botling 3 (botlingd running on the new folder,
// sending messages and changing settings, then stopping), the 2.x source folder is completely
// untouched (identical file list, sizes, mtimes, and SHA-256 hashes) and the 2.x Core opens it
// with 2.x options and sees every bot, line, pin, subagent, plugin, and setting as before.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type Outbound } from "../../src/contract";
import { coreProcessOptions, plainHostNode } from "../../src/core/core-process";
import { testSealer } from "../../src/core/plugins/secrets";
import { Core } from "../../src/core/server";
import { FileBotStore } from "../../src/core/store/bot-store";
import { readLockHolder } from "../../src/core/store/data-dir-lock";
import { MAIN_BOT_ID, MAINTAINER_ID } from "../../src/core/store/records";
import { Layout } from "../../src/core/store/workspace";
import type { Message, MessageOf, Slot } from "../../src/protocol";
import { BotlingdProcess, botlingdCommand, mainBotOf, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, fakeCli, fakeCodex, until } from "../helpers";
import { make2xFolder, type Fixture2xResult } from "../support/fixture-2x";

interface FileSnapshot {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

function collectFiles(root: string, dir = root, out: FileSnapshot[] = []): FileSnapshot[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
    } else if (entry.isFile()) {
      const stat = statSync(full);
      const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
      out.push({ rel: relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    }
  }
  return out;
}

function setModeRecursive(dir: string, dirMode: number, fileMode: number): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      setModeRecursive(full, dirMode, fileMode);
      chmodSync(full, dirMode);
    } else {
      chmodSync(full, fileMode);
    }
  }
  chmodSync(dir, dirMode);
}

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch && m.slot.target === slot.target;

const roots: string[] = [];
const daemons: BotlingdProcess[] = [];
const cores: Core[] = [];

function makeRoot(name = "import-rollback"): string {
  const dir = realpathSync.native(testRoot(name));
  roots.push(dir);
  return dir;
}

function open2xCore(dataDir: string, sealKey: string): { core: Core; outbound: Outbound[] } {
  const outbound: Outbound[] = [];
  const env: Record<string, string> = {
    BOTLING_AGENT: "fake",
    BOTLING_FAKE_CLI: fakeCli,
    BOTLING_FAKE_CODEX: fakeCodex,
    BOTLING_COMPONENT_SCAN_MS: "0",
    BOTLING_WAITING_SCAN_MS: "0",
    BOTLING_ROUTINE_TICK_MS: "0",
    BOTLING_WATCH_MS: "0",
    BOTLING_QUIT_TIDY_MS: "0",
    BOTLING_TEST_SEAL_KEY: sealKey,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const core = new Core(
    coreProcessOptions({
      env,
      dataDir,
      outDir: join(desktop, "out"),
      emit: (message) => outbound.push(message),
      log: () => {},
      node: plainHostNode(env),
      sealer: testSealer(sealKey),
      app: null,
    }),
  );
  cores.push(core);
  return { core, outbound };
}

async function coreCall<T = any>(core: Core, outbound: Outbound[], cmd: unknown): Promise<T> {
  const id = `core-req-${Math.random().toString(36).slice(2)}`;
  core.receive({ v: PROTOCOL_VERSION, id, cmd });
  const response = await until(
    () => outbound.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === id),
    { timeout: 30_000, what: `2.x core response to ${JSON.stringify(cmd)}` },
  );
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result as T;
}

async function exerciseBotling3(v3DataDir: string, options: { sendToProject?: boolean } = {}): Promise<{ v3MainId: string }> {
  const daemon = new BotlingdProcess(v3DataDir);
  daemons.push(daemon);
  await daemon.ready();

  const v3MainId = mainBotOf(v3DataDir);
  expect(v3MainId).toBeTruthy();

  const originEpoch = "11112222333344445555666677778888";
  const client = new ScriptClient("rollback-check", originEpoch);
  try {
    await client.connect(daemon.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const inc = srvSnap.logId;

    await client.sub(`bot:${v3MainId}`);
    await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${v3MainId}`, "bot snap");

    // 1. Send a message on Botling 3's main bot and wait for the reply to finish.
    const chatSlot: Slot = { origin: "rollback-check", originEpoch, target: `bot:${v3MainId}`, n: 1 };
    client.cmd(chatSlot, { type: "chat.send", botId: v3MainId, text: "/say Botling 3 new message" }, inc);
    const chatResult = await client.wait(isResult(chatSlot), "chat.send cmd.result");
    expect(chatResult.outcome.kind).toBe("applied");

    await until(
      () =>
        client.entriesOf(`bot:${v3MainId}`).find(
          (entry) =>
            entry.kind === "turn.finished" &&
            typeof (entry.body as { text?: string }).text === "string" &&
            (entry.body as { text: string }).text.includes("Botling 3 new message"),
        ) ?? null,
      { timeout: 60_000, what: "Botling 3 main turn.finished" },
    );

    // Optionally also run a turn on an imported project bot whose 2.x folder lived inside the 2.x root.
    if (options.sendToProject) {
      const snap = await client.req({ type: "chat.snapshot" });
      if (!snap.ok) throw new Error(snap.error.message);
      const project1 = (snap.result as { bots: Array<{ id: string; name: string }> }).bots.find((b) => b.name === "Project 1");
      expect(project1).toBeDefined();
      const projectId = project1!.id;
      await client.sub(`bot:${projectId}`);
      await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `bot:${projectId}`, "project snap");

      const projSlot: Slot = { origin: "rollback-check", originEpoch, target: `bot:${projectId}`, n: 1 };
      client.cmd(projSlot, { type: "chat.send", botId: projectId, text: "/say Botling 3 project message" }, inc);
      const projResult = await client.wait(isResult(projSlot), "project chat.send cmd.result");
      expect(projResult.outcome.kind).toBe("applied");

      await until(
        () =>
          client.entriesOf(`bot:${projectId}`).find(
            (entry) =>
              entry.kind === "turn.finished" &&
              typeof (entry.body as { text?: string }).text === "string" &&
              (entry.body as { text: string }).text.includes("Botling 3 project message"),
          ) ?? null,
        { timeout: 60_000, what: "Botling 3 project turn.finished" },
      );
    }

    // 2. Change settings in Botling 3.
    const langSlot: Slot = { origin: "rollback-check", originEpoch, target: client.srv, n: 1 };
    client.cmd(langSlot, { type: "settings.set", change: { key: "language", value: "zh-Hant" } }, inc);
    expect((await client.wait(isResult(langSlot), "language settings.set")).outcome.kind).toBe("applied");

    const themeSlot: Slot = { origin: "rollback-check", originEpoch, target: client.srv, n: 2 };
    client.cmd(themeSlot, { type: "settings.set", change: { key: "appTheme", value: "light" } }, inc);
    expect((await client.wait(isResult(themeSlot), "appTheme settings.set")).outcome.kind).toBe("applied");

    // Verify Botling 3 actually reflects the new message and changed settings.
    const afterSnap = await client.req({ type: "chat.snapshot", botId: v3MainId });
    if (!afterSnap.ok) throw new Error(afterSnap.error.message);
    const v3Messages = (afterSnap.result as { chat: { messages: Array<{ text: string }> } }).chat.messages;
    expect(v3Messages.some((m) => m.text.includes("Botling 3 new message"))).toBe(true);

    const v3Settings = await client.req({ type: "settings.get" });
    if (!v3Settings.ok) throw new Error(v3Settings.error.message);
    expect(v3Settings.result).toMatchObject({ language: "zh-Hant", appTheme: "light" });
  } finally {
    client.close();
    expect(await daemon.stop()).toBe(0);
  }

  return { v3MainId };
}

async function assert2xCoreRollbackIntact(src: string, fx: Fixture2xResult): Promise<void> {
  const { core, outbound } = open2xCore(src, fx.sealKey);
  expect(core.mainBotId).toBe(MAIN_BOT_ID);
  expect(core.maintainerId).toBe(MAINTAINER_ID);

  // Wait for the 2.x plugin host & botling.board to load main's pins.json.
  const loadedPins = await until(
    async () => {
      const list = await coreCall<{ host: { running: boolean }; plugins: Array<{ name: string; enabled: boolean }> }>(
        core,
        outbound,
        { type: "plugins.list" },
      );
      if (!list.host.running) return null;
      if (!list.plugins.some((p) => p.name === "botling.board" && p.enabled)) return null;
      if (!list.plugins.some((p) => p.name === fx.pluginName && p.enabled)) return null;
      const snap = await coreCall<{
        chat?: { pluginData?: Record<string, { pins?: Array<{ id: string; name: string; size: string; display: { data: string } }> }> };
      }>(core, outbound, { type: "chat.snapshot", botId: MAIN_BOT_ID });
      const pins = snap.chat?.pluginData?.["botling.board"]?.pins;
      return pins && pins.length > 0 ? pins : null;
    },
    { timeout: 30_000, what: "2.x core plugin host and botling.board pins" },
  );

  expect(loadedPins).toHaveLength(fx.mainPins.length);
  expect(loadedPins[0]).toMatchObject({
    id: (fx.mainPins[0] as { id: string }).id,
    name: "summary-card",
    size: "2x1",
    display: { data: '{"ok":true}' },
  });

  // Main bot: all bots, exact 2.x lines, no Botling 3 lines, original 2.x settings.
  const mainSnap = await coreCall<{
    bots: Array<{ id: string; name: string; role: string }>;
    chat: { messages: Array<{ id: string; text: string }> } | null;
    settings: {
      language: string | null;
      appTheme: string;
      reportTheme: string;
      pinnedBots: string[];
      claudeBypassPermissions: boolean;
      claudeWorkerLimit: number;
      railCollapsed: boolean;
      botLook: string;
    };
  }>(core, outbound, { type: "chat.snapshot" });

  const expectedBotIds = [MAIN_BOT_ID, MAINTAINER_ID, ...fx.projectIds, ...fx.standaloneIds];
  expect(mainSnap.bots).toHaveLength(expectedBotIds.length);
  for (const id of expectedBotIds) {
    expect(mainSnap.bots.some((b) => b.id === id)).toBe(true);
  }
  expect(mainSnap.chat?.messages.map((m) => ({ id: m.id, text: m.text }))).toEqual(
    fx.mainMessages.map((m) => ({ id: m.id, text: m.text })),
  );
  expect(mainSnap.chat?.messages.some((m) => m.text.includes("Botling 3"))).toBe(false);

  // Every other bot keeps its exact 2.x chat lines.
  const expectedPerBot: Array<[string, string[]]> = [
    [MAINTAINER_ID, ["Check plugins"]],
    [fx.projectIds[0]!, ["Work on project 1"]],
    [fx.projectIds[1]!, ["Work on project 2"]],
    [fx.standaloneIds[0]!, ["Standalone 1 ready"]],
  ];
  for (const [botId, expectedTexts] of expectedPerBot) {
    const snap = await coreCall<{ chat: { messages: Array<{ text: string }> } | null }>(core, outbound, {
      type: "chat.snapshot",
      botId,
    });
    expect(snap.chat?.messages.map((m) => m.text)).toEqual(expectedTexts);
  }

  // Settings in 2.x Core are completely unchanged (not zh-Hant / light from Botling 3).
  const settings = await coreCall<typeof mainSnap.settings>(core, outbound, { type: "settings.get" });
  expect(settings).toMatchObject({
    language: "en",
    appTheme: "dark",
    reportTheme: "system",
    pinnedBots: [MAIN_BOT_ID, fx.projectIds[0]],
    claudeBypassPermissions: false,
    claudeWorkerLimit: 4,
    railCollapsed: false,
    botLook: "cute",
  });

  // Pins, specs, tasks, and subagents in the 2.x store remain intact.
  const mainStore = new FileBotStore(Layout.mainBot(src));
  expect(mainStore.loadList("pins.json")).toEqual(fx.mainPins);
  expect(mainStore.loadList("specs.json")).toEqual(fx.mainSpecs);
  expect(mainStore.loadList("tasks.json")).toEqual(fx.mainTasks);

  const subagent = await coreCall<{ subagent: { id: string; prompt: string; steps: unknown[] } }>(
    core,
    outbound,
    { type: "subagent.view", botId: MAIN_BOT_ID, subagentId: fx.subagentId },
  );
  expect(subagent.subagent).toMatchObject({ id: fx.subagentId, prompt: "Find files" });
  expect(subagent.subagent.steps).toHaveLength(1);

  await core.shutdown();
  cores.splice(cores.indexOf(core), 1);
}

afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.shutdown().catch(() => undefined);
  }
  for (const daemon of daemons.splice(0)) {
    await daemon.stop("SIGKILL").catch(() => undefined);
  }
  for (const dir of roots.splice(0)) {
    try {
      setModeRecursive(dir, 0o755, 0o644);
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("M6-09: rollback to 2.x at any time", () => {
  it("after import, botlingd message + setting change, and stop, source hashes are equal and 2.x Core opens with every bot, line, pin, and setting intact", async () => {
    const root = makeRoot("rollback-main");
    const src = join(root, "v2");
    const v3DataDir = join(root, "v3");
    const fx = make2xFolder(src);
    const before = collectFiles(src);

    // 1. Import 2.x -> 3.x via the real CLI.
    const imported = botlingdCommand(v3DataDir, ["import", src]);
    expect(imported.code, imported.stderr).toBe(0);
    expect(collectFiles(src)).toEqual(before);

    // 2. Run botlingd on the new 3.x folder, send a message, change settings, then stop.
    await exerciseBotling3(v3DataDir);

    // 3. Source folder must remain byte-for-byte identical (same files, sizes, mtimes, SHA-256 hashes, no lock).
    expect(readLockHolder(src)).toBeNull();
    expect(collectFiles(src)).toEqual(before);

    // 4. Open the 2.x Core (new Core with 2.x options) on the untouched source folder.
    await assert2xCoreRollbackIntact(src, fx);

  }, 120_000);

  it("import and botlingd turns (main + project bot) + settings changes succeed even when the 2.x source folder is read-only", async () => {
    const root = makeRoot("rollback-ro");
    const src = join(root, "v2");
    const v3DataDir = join(root, "v3");
    const fx = make2xFolder(src);
    const before = collectFiles(src);

    // Make the entire 2.x source folder read-only so any write attempt by Botling 3 fails at the OS level.
    setModeRecursive(src, 0o555, 0o444);
    try {
      const imported = botlingdCommand(v3DataDir, ["import", src]);
      expect(imported.code, imported.stderr).toBe(0);

      await exerciseBotling3(v3DataDir, { sendToProject: true });
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    expect(collectFiles(src)).toEqual(before);
    await assert2xCoreRollbackIntact(src, fx);
  }, 120_000);
});
