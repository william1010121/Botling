// M6-10a: headless parity checklist on a botlingd made from a 2.x fixture import (no real 2.x data, no secrets).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHead } from "../../src/core/agent/head";
import { previewFile } from "../../src/core/preview-url";
import { FileBotStore } from "../../src/core/store/bot-store";
import { MAIN_BOT_ID, MAINTAINER_ID, toSwiftDate, type ChatRecord, type ProjectRecord } from "../../src/core/store/records";
import { Layout } from "../../src/core/store/workspace";
import type { Entry, Message, MessageOf, Slot } from "../../src/protocol";
import { gitRpc } from "../../src/remote/agent/git";
import { AgentServer, machineConfig } from "../../src/remote/agent/server";
import { APP_VERSION } from "../../src/remote/protocol";
import { MachineStore } from "../../src/remote/machines";
import { AgentRelay, pairMachine } from "../../src/remote/relay/agent";
import { MiniWebSocket } from "../../src/remote/relay/ws";
import { Botlingd } from "../../src/server/botlingd";
import { ContentService } from "../../src/server/content";
import { fixedIds } from "../../src/server/fixed-ids";
import { bindServerIdentity, loadOrCreateServerIdentity } from "../../src/server/identity";
import { read2x } from "../../src/server/import";
import { importApprovals } from "../../src/server/import/approvals";
import { importChats } from "../../src/server/import/chats";
import { mapIds, type IdMapRow } from "../../src/server/import/id-map";
import { copyMedia, planMedia } from "../../src/server/import/media";
import { importPlugins } from "../../src/server/import/plugins";
import { LAYOUT_SETTINGS_KEYS, mapSettings } from "../../src/server/import/settings-map";
import { PrefsStore } from "../../src/server/roster/prefs";
import { openServerStore } from "../../src/server/store";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { make2xFolder, type Fixture2xResult } from "../support/fixture-2x";

const agentBundle = join(desktop, "out/agent/botling-agent.cjs");
const builtInsDir = join(desktop, "out/builtin-plugins");
const fakeSsh = join(desktop, "test/fixtures/fake-ssh.sh");
const fakeClaude = join(desktop, "test/fixtures/fake-claude.mjs");
const relayServerModule = new URL("../../../relay/src/server.ts", import.meta.url).href;
const relayConfigModule = new URL("../../../relay/src/config.ts", import.meta.url).href;

const CARD_NAME = "summary-card";
const CARD_COMMAND = `printf '{"summary":"Approved live ok"}'`;
const REPORT_MSG_ID = "99999999-0000-4000-8000-000000000001";
const CARD_MSG_ID = "99999999-0000-4000-8000-000000000002";
const INSIDE_PIC_MSG_ID = "99999999-0000-4000-8000-000000000003";
const OUTSIDE_PIC_MSG_ID = "99999999-0000-4000-8000-000000000004";
const PIN_ID = "99999999-0000-4000-8000-000000000010";
const SPEC_ID = "99999999-0000-4000-8000-000000000020";

const isResult = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> =>
  m.t === "cmd.result" && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

function png(tag: string, size = 1024): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([head, Buffer.alloc(size - head.length, tag)]);
}

function initGitRepo(folder: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8" });
  mkdirSync(folder, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Parity Test");
  git("config", "user.email", "parity@example.invalid");
  writeFileSync(join(folder, "README.md"), "# project\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "init");
}

function readJsonLines(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface ParityEnv {
  root: string;
  sourceDir: string;
  dataDir: string;
  remoteHome: string;
  allowedFolders: string[];
  reportFile: string;
  insidePngPath: string;
  insidePngBytes: Buffer;
  outsidePngPath: string;
  outsidePngBytes: Buffer;
  claudeLog: string;
  inputLog: string;
  sshLog: string;
  pidsFile: string;
  fixture: Fixture2xResult;
  idMap: IdMapRow[];
  mainId: string;
  maintainerId: string;
  projectIds: string[];
  standaloneIds: string[];
}

describe("M6-10a: Botling 3 parity checklist after 2.x fixture import", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  function withEnv(overrides: Record<string, string>): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    cleanups.push(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  async function importFixture(opts: { remoteWorkerProjectIndex?: number } = {}): Promise<ParityEnv> {
    const root = realpathSync.native(testRoot("parity"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const sourceDir = join(root, "v2");
    const dataDir = join(root, "data");
    const remoteHome = join(root, "remote-home");
    const allowedFolders = [join(root, "allowed-docs"), join(root, "allowed-refs")];
    const outsideDir = join(root, "outside-media");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(remoteHome, { recursive: true });
    for (const dir of allowedFolders) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note.txt"), "allowed note\n");
    }
    mkdirSync(outsideDir, { recursive: true });

    const pidsFile = join(root, "pids.log");
    cleanups.push(() => {
      if (!existsSync(pidsFile)) return;
      for (const line of readFileSync(pidsFile, "utf8").split("\n")) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    });

    const insidePngPath = join(sourceDir, "main", "diagram.png");
    const insidePngBytes = png("IN");
    mkdirSync(join(sourceDir, "main"), { recursive: true });
    writeFileSync(insidePngPath, insidePngBytes);

    const outsidePngPath = join(outsideDir, "outside.png");
    const outsidePngBytes = png("EX");
    writeFileSync(outsidePngPath, outsidePngBytes);

    const baseDate = toSwiftDate(Date.UTC(2026, 0, 1, 13, 0, 0));
    const extraMainMessages: ChatRecord[] = [
      { id: CARD_MSG_ID, role: "bot", text: "Pinned summary", date: baseDate + 1, state: "done", displays: [{ name: CARD_NAME, data: "null" }] },
      { id: INSIDE_PIC_MSG_ID, role: "user", text: "Inside image", date: baseDate + 2, attachments: [{ url: pathToFileURL(insidePngPath).href, kind: "image" }] },
      { id: OUTSIDE_PIC_MSG_ID, role: "user", text: "Outside image", date: baseDate + 3, attachments: [{ url: pathToFileURL(outsidePngPath).href, kind: "image" }] },
    ];

    const fixture = make2xFolder(sourceDir, {
      folders: allowedFolders,
      settings: { languageChoice: "zh-Hant", appTheme: "light", reportTheme: "dark" },
      extraMainMessages,
    });

    // Git-initialize project folders so local & remote workers can operate cleanly.
    for (const dir of fixture.projectDirs) initGitRepo(dir);

    // 2.x report page inside project 1's folder, linked from an imported bot reply.
    const reportFile = join(fixture.projectDirs[0]!, ".bot", "artifacts", "weekly-report.html");
    mkdirSync(join(fixture.projectDirs[0]!, ".bot", "artifacts"), { recursive: true });
    writeFileSync(reportFile, "<!doctype html><meta charset=\"utf-8\"><title>Weekly Report</title><h1>Parity Report</h1>\n");
    const p1Store = new FileBotStore(Layout.bot(sourceDir, fixture.projectIds[0]!));
    p1Store.saveMessages([
      ...p1Store.loadMessages().records,
      { id: REPORT_MSG_ID, role: "bot", text: `Report ready: [Weekly Report](${pathToFileURL(reportFile).href})`, date: baseDate + 4, state: "done" },
    ]);

    // 2.x ccb-components library with a command component (`summary-card`), valid spec & pin on main.
    const compPluginDir = join(sourceDir, "plugins", "ccb-components");
    const cardDir = join(compPluginDir, "components", CARD_NAME);
    mkdirSync(cardDir, { recursive: true });
    writeFileSync(join(compPluginDir, "package.json"), JSON.stringify({ name: "ccb-components", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: {} }));
    writeFileSync(join(cardDir, "about.md"), `Summary card: prints a live summary JSON.\nData: {"summary": "default"}\nSizes: 2x1\nIcon: 📊\nCommand: ${CARD_COMMAND}\n`);
    writeFileSync(join(cardDir, "template.html"), `<div class="card"><b id="s"></b></div><script>document.getElementById('s').textContent=(ccb.data&&ccb.data.summary)||'';</script>`);

    const mainDir2x = Layout.mainBot(sourceDir);
    const mainStore2x = new FileBotStore(mainDir2x);
    mainStore2x.saveList("pins.json", [
      { id: PIN_ID, messageId: CARD_MSG_ID, name: CARD_NAME, data: "null", command: CARD_COMMAND, refresh: "shown", minutes: 15, size: "2x1", makingLive: false },
    ]);
    mainStore2x.saveList("specs.json", [
      {
        id: SPEC_ID,
        messageID: CARD_MSG_ID,
        name: CARD_NAME,
        about: "Summary card spec",
        fields: [{ name: "summary", type: "string", by: "user" }],
        command: CARD_COMMAND,
        folder: mainDir2x,
        refresh: "manual",
        minutes: 15,
        bots: [MAIN_BOT_ID],
        reuse: false,
        samples: [],
        questions: [],
        conversation: [],
        origins: {},
        status: "done",
        draft: 1,
        opened: true,
        asked: false,
        pendingEdits: [],
        createdAt: baseDate,
      },
    ]);

    // Approve `CARD_COMMAND` only for main (and Project 1's `npm test`), leaving Project 2 unapproved.
    writeFileSync(
      join(sourceDir, "approved-commands.json"),
      JSON.stringify({
        [mainDir2x]: [CARD_COMMAND],
        [fixture.projectDirs[0]!]: ["npm test"],
      }, null, 2),
    );

    // Import into `dataDir` using M6 import primitives while botlingd is stopped.
    mkdirSync(dataDir, { recursive: true });
    const identity = await loadOrCreateServerIdentity(dataDir, { create: true });
    const store = await openServerStore(dataDir);
    const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
    const ids = await store.submit((tx) => fixedIds(tx, { created: identity.created }));

    const read = read2x(sourceDir);
    const idMap = mapIds(read.bots, { mainId: ids.main, maintainerId: ids.maintainer, designated: true });
    const idMapMap = new Map(idMap.map((r) => [r.oldId, r.newId]));
    const sourceHash = createHash("sha256").update(realpathSync.native(sourceDir)).digest("hex").slice(0, 16);

    const copiedMedia = copyMedia(planMedia(read.bots, idMap, sourceDir), dataDir, sourceHash);
    expect(copiedMedia.failed).toEqual([]);

    const content = new ContentService({ store, dataDir, serverId });
    const chatRes = await importChats(store, read.bots, idMap, {
      source: sourceHash,
      content,
      attachmentMap: copiedMedia.map,
    });
    await content.close();
    expect(chatRes.bots.every((b) => b.problems.length === 0)).toBe(true);

    // Copy main memory and standalone working folders + projects.json for Core.
    mkdirSync(Layout.mainBot(dataDir), { recursive: true });
    const mainMem = join(Layout.mainBot(sourceDir), "memory.md");
    if (existsSync(mainMem)) writeFileSync(join(Layout.mainBot(dataDir), "memory.md"), readFileSync(mainMem));

    const projects: ProjectRecord[] = [];
    for (const bot of read.bots) {
      if (bot.role === "main" || bot.id.toUpperCase() === MAINTAINER_ID) continue;
      const newId = idMapMap.get(bot.id)!;
      if (bot.standalone) {
        const dstOwn = Layout.standalone(dataDir, newId);
        cpSync(bot.folder, dstOwn, { recursive: true });
        projects.push({ id: newId, name: bot.name, folder: pathToFileURL(dstOwn + sep).toString(), avatar: "star", job: "Summarize daily logs" });
      } else {
        const rawList = JSON.parse(readFileSync(Layout.projectsFile(sourceDir), "utf8")) as ProjectRecord[];
        const found = rawList.find((p) => p.id.toUpperCase() === bot.id.toUpperCase());
        if (found) projects.push({ ...found, id: newId });
      }
    }
    writeFileSync(Layout.projectsFile(dataDir), JSON.stringify(projects, null, 2));

    const readerDb = store.openReader();
    try {
      const approvals = importApprovals({
        sourceDir,
        targetDir: dataDir,
        idMap,
        db: readerDb,
        bots: read.bots.map((b) => ({ oldId: b.id, newId: idMapMap.get(b.id)!, name: b.name, chatDir: b.chatDir })),
      });
      expect(approvals.problems).toEqual([]);
    } finally {
      readerDb.close();
    }

    const mappedSettings = mapSettings(read.settings, idMapMap);
    const prefs = await PrefsStore.open(store, { self: memberId });
    for (const item of mappedSettings.prefs) {
      await prefs.set(item.key, item.value);
    }
    writeFileSync(Layout.settings(dataDir), JSON.stringify(mappedSettings.machine, null, 2));

    const pluginResult = importPlugins(sourceDir, dataDir, { builtInsDir });
    expect(pluginResult.hashMismatches).toEqual([]);
    await store.close();

    if (opts.remoteWorkerProjectIndex !== undefined) {
      const machines = MachineStore.in(dataDir);
      const box = machines.add({
        name: "box",
        via: "ssh",
        host: "box",
        hostKey: { fingerprint: "SHA256:test", lines: ["ssh-ed25519 AAAAtest"], known: false },
      });
      machines.approve(box.id);
    }

    return {
      root,
      sourceDir,
      dataDir,
      remoteHome,
      allowedFolders,
      reportFile,
      insidePngPath,
      insidePngBytes,
      outsidePngPath,
      outsidePngBytes,
      claudeLog: join(root, "claude.log"),
      inputLog: join(root, "input.log"),
      sshLog: join(root, "ssh.log"),
      pidsFile,
      fixture,
      idMap,
      mainId: ids.main,
      maintainerId: ids.maintainer,
      projectIds: fixture.projectIds.map((id) => idMapMap.get(id)!),
      standaloneIds: fixture.standaloneIds.map((id) => idMapMap.get(id)!),
    };
  }

  async function startDaemonAndClient(
    env: ParityEnv,
    extraEnv: Record<string, string> = {},
    deviceId = "parity-device",
  ): Promise<{ daemon: Botlingd; client: ScriptClient; inc: string; originEpoch: string }> {
    withEnv({
      FAKE_CLAUDE_LOG: env.claudeLog,
      FAKE_CLAUDE_INPUT: env.inputLog,
      FAKE_CLAUDE_PIDS: env.pidsFile,
      ...extraEnv,
    });
    const daemon = await Botlingd.start({
      env: botlingdEnv(env.dataDir, {
        BOTLING_REMOTE_WORKERS: "1",
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
        BOTLING_PLAIN_SHELL: "1",
        FAKE_CLAUDE_LOG: env.claudeLog,
        FAKE_CLAUDE_INPUT: env.inputLog,
        FAKE_CLAUDE_PIDS: env.pidsFile,
        ...extraEnv,
      }),
      outDir: join(desktop, "out"),
    });
    cleanups.push(() => daemon.stop());

    const client = new ScriptClient(deviceId);
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    return { daemon, client, inc: srvSnap.logId, originEpoch: client.originEpoch };
  }

  function makeSender(client: ScriptClient, inc: string, originEpoch: string) {
    const seqs = new Map<string, number>();
    return async (target: string, cmd: unknown, what: string) => {
      const n = seqs.get(target) ?? 1;
      seqs.set(target, n + 1);
      const slot: Slot = { origin: client.deviceId, originEpoch, target, n };
      client.cmd(slot, cmd, inc);
      const result = await client.wait(isResult(slot), what);
      expect(result.outcome.kind).toBe("applied");
      return (result.outcome as { kind: "applied"; result?: unknown }).result;
    };
  }

  async function reqOk<T>(client: ScriptClient, cmd: unknown): Promise<T> {
    const res = await client.req(cmd);
    if (!res.ok) throw new Error(`${JSON.stringify(cmd)} failed: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  async function subBot(client: ScriptClient, botId: string): Promise<string> {
    const stream = `bot:${botId}`;
    await client.sub(stream);
    await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === stream, `snap ${stream}`);
    return stream;
  }

  it("1. every imported bot opens with its history and replies to a new message (fake CLI)", async () => {
    const env = await importFixture();
    const { client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);

    const expected: Array<{ id: string; historyText: string; prompt: string }> = [
      { id: env.mainId, historyText: "Hello back", prompt: "Ping main bot" },
      { id: env.maintainerId, historyText: "Check plugins", prompt: "Ping maintainer" },
      { id: env.projectIds[0]!, historyText: "Work on project 1", prompt: "Ping project 1" },
      { id: env.projectIds[1]!, historyText: "Work on project 2", prompt: "Ping project 2" },
      { id: env.standaloneIds[0]!, historyText: "Standalone 1 ready", prompt: "Ping standalone 1" },
    ];

    for (const item of expected) {
      const stream = await subBot(client, item.id);
      const snap = await reqOk<{ chat: { messages: Array<{ text: string }> } }>(client, { type: "chat.snapshot", botId: item.id });
      expect(snap.chat.messages.some((m) => m.text.includes(item.historyText))).toBe(true);

      await send(stream, { type: "chat.send", botId: item.id, text: item.prompt }, `chat.send ${item.id}`);
      await until(
        () =>
          client.entriesOf(stream).find(
            (e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes(`You said: ${item.prompt}`),
          ) ?? null,
        { timeout: 30_000, what: `reply from ${item.id}` },
      );
    }
  }, 60_000);

  it("2. pins, specs, tasks, and subagents show; a pinned card still renders and refreshes live", async () => {
    const env = await importFixture();
    const { daemon, client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);
    await subBot(client, env.mainId);

    // Wait for built-in plugins (botling.board, botling.component-studio) to start.
    await until(async () => {
      const listRes = await client.req({ type: "plugins.list" });
      if (!listRes.ok) return null;
      const list = listRes.result as { host: { running: boolean }; plugins: Array<{ name: string; enabled: boolean }> };
      const hasBoard = list.plugins.some((p) => p.name === "botling.board" && p.enabled);
      const hasStudio = list.plugins.some((p) => p.name === "botling.component-studio" && p.enabled);
      return list.host.running && hasBoard && hasStudio ? true : null;
    }, { timeout: 30_000, what: "built-in plugins running" });

    // Open board view and show imported pin so botling.board publishes and runs the approved pin command.
    await send(client.srv, { type: "plugins.call", name: "botling.board", method: "view", params: { botId: env.mainId }, from: "chat" }, "board.view");
    await send(
      client.srv,
      { type: "plugins.call", name: "botling.board", method: "action", params: { botId: env.mainId, action: { type: "pinShown", ids: [PIN_ID] } }, from: "chat" },
      "board.pinShown",
    );

    const snap = await until(async () => {
      const res = await client.req({ type: "chat.snapshot", botId: env.mainId });
      if (!res.ok) return null;
      const body = res.result as {
        components: Record<string, { template?: string }>;
        chat: {
          pluginData?: Record<string, { pins?: Array<{ id: string; name: string; display: { status: string; data: string } }> }>;
          decorations?: Array<{ under?: string; data?: { specs?: Array<{ id: string; name: string }> } }>;
        };
      };
      const pins = body.chat.pluginData?.["botling.board"]?.pins ?? [];
      const pin = pins.find((p) => p.id === PIN_ID);
      const specsDec = (body.chat.decorations ?? []).find((d) => d.data?.specs?.some((s) => s.id === SPEC_ID));
      return pin && pin.display.status === "done" && specsDec ? body : null;
    }, { timeout: 30_000, what: "pin rendered live and spec decorated" });

    expect(snap.components[CARD_NAME]?.template).toContain("ccb.data");
    const renderedPin = snap.chat.pluginData!["botling.board"]!.pins!.find((p) => p.id === PIN_ID)!;
    expect(renderedPin.display.data).toBe(`{"summary":"Approved live ok"}`);

    // Tasks preserved in bot store without breaking chat load.
    const savedTasks = daemon.stores.open(env.mainId, Layout.mainBot(env.dataDir)).loadList("tasks.json") as Array<{ title: string }>;
    expect(savedTasks).toEqual([expect.objectContaining({ title: "Review notes" })]);

    // Subagents open with steps.
    const subView = await reqOk<{ subagent: { id: string; status: string; prompt: string; result: string | null; steps: Array<{ title: string; output?: string }> } }>(client, { type: "subagent.view", botId: env.mainId, subagentId: env.fixture.subagentId });
    expect(subView.subagent).toMatchObject({ id: env.fixture.subagentId, prompt: "Find files", result: "Found 2 files", status: "stopped" });
    expect(subView.subagent.steps.some((s) => s.title === "Read note.txt" && s.output === "attachment body")).toBe(true);
  }, 60_000);

  it("3. designated main bot and Maintainer answer; Maintainer gets --add-dir for imported folders", async () => {
    const env = await importFixture();
    const { daemon, client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);

    expect(env.mainId).not.toBe(MAIN_BOT_ID);
    expect(env.maintainerId).not.toBe(MAINTAINER_ID);
    expect(daemon.core.mainBotId).toBe(env.mainId);
    expect(daemon.core.maintainerId).toBe(env.maintainerId);

    const mainStream = await subBot(client, env.mainId);
    await send(mainStream, { type: "chat.send", botId: env.mainId, text: "Designated main check" }, "main chat.send");
    await until(
      () => client.entriesOf(mainStream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Designated main check")) ?? null,
      { timeout: 30_000, what: "designated main reply" },
    );

    const maintStream = await subBot(client, env.maintainerId);
    await send(maintStream, { type: "chat.send", botId: env.maintainerId, text: "Check allowed folders" }, "maintainer chat.send");
    await until(
      () => client.entriesOf(maintStream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Check allowed folders")) ?? null,
      { timeout: 30_000, what: "maintainer reply" },
    );

    const starts = readJsonLines(env.claudeLog) as Array<{ args?: string[] }>;
    const withAllowedDirs = starts.find((entry) => {
      const argv = entry.args ?? [];
      return env.allowedFolders.every((folder) => {
        for (let i = 0; i < argv.length - 1; i++) {
          if (argv[i] === "--add-dir" && argv[i + 1] === folder) return true;
        }
        return false;
      });
    });
    expect(withAllowedDirs).toBeDefined();
  }, 60_000);

  it("4. approved component commands run without asking; unapproved folders still require approval", async () => {
    const env = await importFixture();
    const { client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);

    const mainStream = await subBot(client, env.mainId);
    await send(mainStream, { type: "chat.send", botId: env.mainId, text: `/say <show name="${CARD_NAME}"></show>` }, "main show card");
    const mainTurn = await until(async () => {
      const snap = await reqOk<{
        chat: { messages: Array<{ id: string; role: string; state?: string; displays?: Array<{ name: string }> }> };
      }>(client, { type: "chat.snapshot", botId: env.mainId });
      return snap.chat.messages.find((m) => m.id !== CARD_MSG_ID && m.role === "bot" && m.state === "done" && m.displays?.some((d) => d.name === CARD_NAME)) ?? null;
    }, { timeout: 30_000, what: "main card reply" });
    const mainMsgId = mainTurn.id;
    const mainCmdResult = (await send(
      mainStream,
      { type: "component.command", botId: env.mainId, messageId: mainMsgId, index: 0, command: CARD_COMMAND, folder: Layout.mainBot(env.dataDir) },
      "component.command approved",
    )) as { accepted: boolean; needsApproval?: unknown };
    expect(mainCmdResult.accepted).toBe(true);
    expect(mainCmdResult.needsApproval).toBeUndefined();

    const disp = await until(async () => {
      const snap = await reqOk<{
        chat: { messages: Array<{ id: string; displays?: Array<{ status: string | null; data: string }> }> };
      }>(client, { type: "chat.snapshot", botId: env.mainId });
      const d = snap.chat.messages.find((m) => m.id === mainMsgId)?.displays?.[0];
      return d?.status === "done" ? d : null;
    }, { timeout: 20_000, what: "approved command finished" });
    expect(disp.data).toBe(`{"summary":"Approved live ok"}`);

    // Unapproved project folder still returns needsApproval.
    const p2Id = env.projectIds[1]!;
    const p2Stream = await subBot(client, p2Id);
    await send(p2Stream, { type: "chat.send", botId: p2Id, text: `/say <show name="${CARD_NAME}"></show>` }, "p2 show card");
    const p2Turn = await until(async () => {
      const snap = await reqOk<{
        chat: { messages: Array<{ id: string; role: string; state?: string; displays?: Array<{ name: string }> }> };
      }>(client, { type: "chat.snapshot", botId: p2Id });
      return snap.chat.messages.find((m) => m.role === "bot" && m.state === "done" && m.displays?.some((d) => d.name === CARD_NAME)) ?? null;
    }, { timeout: 30_000, what: "p2 card reply" });
    const p2MsgId = p2Turn.id;
    const p2CmdResult = (await send(
      p2Stream,
      { type: "component.command", botId: p2Id, messageId: p2MsgId, index: 0, command: CARD_COMMAND, folder: env.fixture.projectDirs[1]! },
      "component.command unapproved",
    )) as { accepted: boolean; needsApproval?: { command: string; folder: string; card: string } };
    expect(p2CmdResult.accepted).toBe(false);
    expect(p2CmdResult.needsApproval).toMatchObject({ command: CARD_COMMAND, folder: env.fixture.projectDirs[1]!, card: CARD_NAME });
  }, 60_000);

  it("5. a report page made in 2.x opens from its line (file: link inside the bot folder)", async () => {
    const env = await importFixture();
    const { client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);

    const p1Id = env.projectIds[0]!;
    await subBot(client, p1Id);
    const snap = await reqOk<{
      chat: { messages: Array<{ id: string; previews?: Array<{ name: string; data: string }> }> };
    }>(client, { type: "chat.snapshot", botId: p1Id });
    const msg = snap.chat.messages.find((m) => m.id === REPORT_MSG_ID);
    expect(msg?.previews?.length).toBe(1);
    const preview = JSON.parse(msg!.previews![0]!.data) as { missing?: boolean; src?: string; url?: string; name?: string };
    expect(preview.missing).not.toBe(true);
    expect(preview.src).toMatch(/^botling-card:\/\/preview\//);
    expect(previewFile(preview.src!)).toBe(realpathSync.native(env.reportFile));

    const authLinked = await send(
      `bot:${p1Id}`,
      { type: "link.authorize", botId: p1Id, messageId: REPORT_MSG_ID, url: pathToFileURL(env.reportFile).href },
      "link.authorize report",
    );
    expect(authLinked).toEqual({ result: true, linked: true });

    const authUnlinked = await send(
      `bot:${p1Id}`,
      { type: "link.authorize", botId: p1Id, messageId: REPORT_MSG_ID, url: "file:///not-linked/other.html" },
      "link.authorize unlinked",
    );
    expect(authUnlinked).toEqual({ result: false, linked: false });

    const storage = await reqOk<{ items: Array<{ path: string }> }>(client, { type: "storage.list", botId: p1Id });
    expect(storage.items.some((item) => realpathSync.native(item.path) === realpathSync.native(env.reportFile))).toBe(true);
  }, 60_000);

  it("6. workers: coordinator starts a local worker and a remote worker via botling-agent and receives each report", async () => {
    expect(existsSync(agentBundle), "out/agent/botling-agent.cjs (npm run build)").toBe(true);
    const env = await importFixture({ remoteWorkerProjectIndex: 1 });
    const remoteReal = realpathSync(env.remoteHome);

    const { startRelay } = await import(/* @vite-ignore */ relayServerModule);
    const { loadConfig } = await import(/* @vite-ignore */ relayConfigModule);
    const relayServer = await startRelay({ ...loadConfig({}), host: "127.0.0.1", port: 0 });
    cleanups.push(() => relayServer.close());
    const relayUrl = `ws://127.0.0.1:${relayServer.port}/ws`;

    withEnv({
      BOTLING_SSH: fakeSsh,
      BOTLING_SSH_NO_CONTROL: "1",
      FAKE_SSH_HOME: env.remoteHome,
      FAKE_SSH_LOG: env.sshLog,
      BOTLING_MACHINE_RELAY: relayUrl,
      BOTLING_AGENT_NO_LOGIN_PATH: "1",
      BOTLING_AGENT_CLAUDE: process.execPath,
      BOTLING_AGENT_CLAUDE_ARGS: JSON.stringify([fakeClaude]),
      FAKE_CLAUDE_RUN_TOOLS: "1",
      FAKE_CLAUDE_REPORT_REPLY: "Worker finished cleanly.",
    });

    const { daemon, client, inc, originEpoch } = await startDaemonAndClient(env);
    const send = makeSender(client, inc, originEpoch);

    // 6a. Local worker on imported Project 1.
    const localBotId = env.projectIds[0]!;
    const localStream = await subBot(client, localBotId);
    await send(localStream, { type: "chat.send", botId: localBotId, text: "/worker Check local files" }, "local worker chat.send");
    await until(
      () => client.entriesOf(localStream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly.")) ?? null,
      { timeout: 60_000, what: "local worker report reply" },
    );

    // 6b. Remote worker on imported Project 2 through botling-agent (relay + agent daemon, M5-11 path).
    const pairResult = (await send(client.srv, { type: "machines.pair" }, "machines.pair")) as { command: string };
    const offer = /botling-machine1\.[A-Za-z0-9_-]+/.exec(pairResult.command)?.[0];
    expect(offer).toBeTruthy();

    const printed: string[] = [];
    const paired = pairMachine({
      home: env.remoteHome,
      offer: offer!,
      name: "gpu-box",
      socket: (u) => new MiniWebSocket(u),
      print: (line) => printed.push(line),
    });
    await until(() => (printed.some((line) => line.includes("Code:")) ? true : null), { timeout: 15_000, what: "pairing code" });
    const code = /Code:\s+(\S+)/.exec(printed.join("\n"))?.[1];
    expect(code).toBeTruthy();

    const viewRes = await reqOk<{ machines: Array<{ id: string; name: string }> }>(client, { type: "machines.view" });
    const machine = viewRes.machines.find((m) => m.name === "gpu-box");
    expect(machine).toBeDefined();
    await send(client.srv, { type: "machines.approve", id: machine!.id, code: code! }, "machines.approve");
    await paired;

    const gitOps = gitRpc(env.remoteHome);
    const agentServer = new AgentServer({
      home: env.remoteHome,
      version: APP_VERSION,
      sha: "",
      config: (spec) => machineConfig(spec),
      spawn: (config, handlers) => new ClaudeHead(config, handlers),
      rpc: async (op, args, link) => (op === "info" ? { version: APP_VERSION, node: process.version, git: "git", claude: "fake" } : gitOps(op, args, link)),
    });
    const agentDaemon = new AgentRelay({ home: env.remoteHome, server: agentServer, socket: (u) => new MiniWebSocket(u), waits: [50, 100, 200] });
    cleanups.push(async () => {
      await agentDaemon.stop();
      await agentServer.close();
    });
    agentDaemon.start();

    await send(client.srv, { type: "machines.check", id: machine!.id }, "machines.check");
    const remoteBotId = env.projectIds[1]!;
    const remoteStream = await subBot(client, remoteBotId);
    await send(remoteStream, { type: "bot.configure", botId: remoteBotId, workerMachine: "gpu-box" }, "bot.configure");
    await send(remoteStream, { type: "chat.send", botId: remoteBotId, text: "/worker /notify:question Which DB?" }, "remote worker chat.send");

    await until(
      () => client.entriesOf(remoteStream).find((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Worker finished cleanly.")) ?? null,
      { timeout: 60_000, what: "remote worker report reply" },
    );
    await until(() => (daemon.runningTurns().length === 0 ? true : null), { timeout: 10_000, what: "no running turns" });

    const claudeStarts = readJsonLines(env.claudeLog);
    expect(claudeStarts.some((s) => typeof s.cwd === "string" && realpathSync(s.cwd).startsWith(remoteReal))).toBe(true);
    const remoteEntries: Entry[] = client.entriesOf(remoteStream);
    expect(
      remoteEntries.some(
        (e) => e.kind === "message.added" && (e.body as { message: { role: string; text: string } }).message.role === "relay"
          && (e.body as { message: { text: string } }).message.text.includes('Question from worker "Research": Which DB?'),
      ),
    ).toBe(true);
    expect(remoteEntries.some((e) => e.kind === "turn.finished" && String((e.body as { text?: string }).text).includes("Answered the worker."))).toBe(true);
  }, 90_000);

  it("7. settings: language and theme are the imported ones on a new device (prefs)", async () => {
    const env = await importFixture();
    await startDaemonAndClient(env, {}, "initial-device");

    // Connect a second brand-new device and inspect cluster prefs.
    const socket = join(env.dataDir, "botlingd.sock");
    const token = readFileSync(join(env.dataDir, "botlingd.token"), "utf8").trim();
    const newDevice = new ScriptClient("brand-new-device");
    cleanups.push(() => newDevice.close());
    await newDevice.connect(socket, token);

    newDevice.send({ t: "admin", req: "prefs-1", op: { op: "prefs.list" } } as Message);
    const res = await newDevice.wait((m): m is MessageOf<"res"> => m.t === "res" && m.req === "prefs-1", "prefs.list");
    if (!res.ok) throw new Error(`prefs.list failed: ${res.error.code} ${res.error.message}`);
    const rows = (res.result as { rows: Array<{ key: string; value: unknown }> }).rows;
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    expect(byKey.get("language")).toBe("zh-Hant");
    expect(byKey.get("theme")).toBe("light");
    expect(byKey.get("reportTheme")).toBe("dark");

    const machineSettings = JSON.parse(readFileSync(Layout.settings(env.dataDir), "utf8")) as Record<string, unknown>;
    for (const layoutKey of LAYOUT_SETTINGS_KEYS) {
      expect(byKey.has(layoutKey)).toBe(false);
      expect(Object.hasOwn(machineSettings, layoutKey)).toBe(false);
    }
  }, 60_000);

  it("8. attachments of old lines open after import, even after the 2.x source folder is moved away", async () => {
    const env = await importFixture();
    const { client } = await startDaemonAndClient(env);
    await subBot(client, env.mainId);

    // Move 2.x source folder away before opening attachments, proving Botling 3 reads the copy under <dataDir>/imported/.
    renameSync(env.sourceDir, `${env.sourceDir}-moved-away`);

    const snap = await reqOk<{
      chat: { messages: Array<{ id: string; attachments?: Array<{ url: string }> }> };
    }>(client, { type: "chat.snapshot", botId: env.mainId });
    const insideMsg = snap.chat.messages.find((m) => m.id === INSIDE_PIC_MSG_ID);
    const outsideMsg = snap.chat.messages.find((m) => m.id === OUTSIDE_PIC_MSG_ID);
    expect(insideMsg?.attachments?.[0]?.url).toBeTruthy();
    expect(outsideMsg?.attachments?.[0]?.url).toBeTruthy();

    const insideUrl = insideMsg!.attachments![0]!.url;
    expect(insideUrl).toContain("/imported/");
    const insideFound = await client.content({ t: "content.find", botId: env.mainId, line: INSIDE_PIC_MSG_ID, url: insideUrl });
    expect(insideFound.t).toBe("content.found");
    const insideRef = (insideFound as MessageOf<"content.found">).ref;
    expect(insideRef).toBeTruthy();

    const insideFile = await client.content({
      t: "content.open",
      owner: insideRef!.owner,
      id: insideRef!.id,
      entry: insideRef!.entry,
      variant: "original",
    });
    expect(insideFile.t).toBe("content.file");
    const insideOpened = insideFile as MessageOf<"content.file">;
    expect(insideOpened.type).toBe("image/png");
    expect(existsSync(fileURLToPath(insideUrl))).toBe(true);
    expect(realpathSync.native(fileURLToPath(insideUrl)).startsWith(join(realpathSync.native(env.dataDir), "imported"))).toBe(true);
    expect(realpathSync.native(insideOpened.path).startsWith(realpathSync.native(env.dataDir))).toBe(true);
    expect(readFileSync(insideOpened.path)).toEqual(env.insidePngBytes);

    const outsideUrl = outsideMsg!.attachments![0]!.url;
    expect(outsideUrl).toBe(pathToFileURL(env.outsidePngPath).href);
    const outsideFound = await client.content({ t: "content.find", botId: env.mainId, line: OUTSIDE_PIC_MSG_ID, url: outsideUrl });
    expect(outsideFound.t).toBe("content.found");
    const outsideRef = (outsideFound as MessageOf<"content.found">).ref;
    expect(outsideRef).toBeTruthy();

    const outsideFile = await client.content({
      t: "content.open",
      owner: outsideRef!.owner,
      id: outsideRef!.id,
      entry: outsideRef!.entry,
      variant: "original",
    });
    expect(outsideFile.t).toBe("content.file");
    expect(readFileSync((outsideFile as MessageOf<"content.file">).path)).toEqual(env.outsidePngBytes);
  }, 60_000);
});
