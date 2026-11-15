// M6-10b — Plugin parity: after a 2.x import, every built-in plugin's panels/views and commands load and run
// within its tier, the fixture's user plugin has its web part loaded while its program part stays off with the
// M5-18a notice until `plugin.grant{tier: "write"}` starts it on its M6-03a copied data folder, and a
// request-tier plugin's command is refused `grant` before its grant and applied within its granted tier after.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginsView, WebPluginSpecView } from "../../src/contract";
import { folderHash } from "../../src/core/plugins/catalog";
import { ResAssembler, type Message, type MessageOf, type Slot, type Via } from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { runImport } from "../../src/server/import/run";
import { botlingdEnv, mainBotOf, ScriptClient, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";
import { make2xFolder } from "../support/fixture-2x";

const HELD_BACK_NOTICE = "Its program part is off until you allow it to change its own data on this server.";

const EXPECTED_BUILTINS = [
  "botling.board", "botling.cards", "botling.catchup", "botling.chat-extras", "botling.component-studio",
  "botling.design", "botling.dev", "botling.git", "botling.note", "botling.report",
  "botling.routines", "botling.terminal", "botling.usage", "botling.whiteboard", "ccb-latex",
] as const;

interface BuiltinManifestInfo {
  name: string;
  hasWeb: boolean;
  hasHost: boolean;
  commands: string[];
  panels: string[];
  views: Array<{ id: string; where: string }>;
  slash: string[];
}

function readBuiltinManifests(builtInsDir: string): BuiltinManifestInfo[] {
  const dirs = readdirSync(builtInsDir).filter((name) => !name.startsWith(".")).sort();
  return dirs.map((name) => {
    const pkg = JSON.parse(readFileSync(join(builtInsDir, name, "package.json"), "utf8")) as {
      name: string;
      ccb?: {
        web?: string;
        host?: string;
        contributes?: {
          commands?: Array<{ id: string }>;
          panels?: Array<{ id: string }>;
          views?: Array<{ id: string; where: string }>;
          slash?: Array<{ name: string }>;
        };
      };
    };
    const ccb = pkg.ccb ?? {};
    const contributes = ccb.contributes ?? {};
    return {
      name: pkg.name,
      hasWeb: Boolean(ccb.web),
      hasHost: Boolean(ccb.host),
      commands: (contributes.commands ?? []).map((c) => c.id),
      panels: (contributes.panels ?? []).map((p) => p.id),
      views: (contributes.views ?? []).map((v) => ({ id: v.id, where: v.where })),
      slash: (contributes.slash ?? []).map((s) => s.name),
    };
  });
}

/** Every entry under `dir` (path, kind, size, mtime, mode): the 2.x folder must be exactly as it was after the import. */
function treeSnapshot(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, path));
    out.push(`${path} ${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"} ${st.size} ${st.mtimeMs} ${st.mode}`);
    if (st.isDirectory()) out.push(...treeSnapshot(dir, path));
  }
  return out;
}

/** The import report's line for one plugin in its "Plugins" table (name, author, status). */
function reportPluginLine(reportText: string, name: string): string | undefined {
  const lines = reportText.split("\n");
  const start = lines.indexOf("Plugins");
  if (start < 0) return undefined;
  return lines.slice(start + 1).find((line) => line.startsWith("  ") && line.trimStart().startsWith(`${name} `));
}

let largeReqSeq = 0;
async function reqLarge(client: ScriptClient, cmd: unknown, timeout = 30_000): Promise<MessageOf<"res">> {
  const req = `parity-large-${++largeReqSeq}`;
  const from = client.received.length;
  client.send({ t: "req", req, cmd } as Message);
  const assembler = new ResAssembler();
  let seen = from;
  return until(() => {
    for (; seen < client.received.length; seen++) {
      const m = client.received[seen]!;
      if (m.t === "res" && m.req === req) return m;
      if (m.t === "res.part" && m.req === req) {
        const pushed = assembler.push(m, { local: true });
        if (!pushed.ok) throw new Error(pushed.detail);
        if (pushed.message) return pushed.message;
      }
    }
    if (client.closed) throw new Error(`session closed while waiting for ${req}`);
    return null;
  }, { timeout, what: `large res ${req}` });
}

function okResult<T>(res: MessageOf<"res">): T {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error.message);
  return res.result as T;
}

const isResultOrRetry = (slot: Slot) => (m: Message): m is MessageOf<"cmd.result"> | MessageOf<"cmd.retry"> =>
  (m.t === "cmd.result" || m.t === "cmd.retry") && m.slot.target === slot.target && m.slot.n === slot.n && m.slot.originEpoch === slot.originEpoch;

async function sendCmd(client: ScriptClient, target: string, n: number, inc: string, cmd: unknown, via?: Via): Promise<MessageOf<"cmd.result">> {
  const slot: Slot = { origin: "script", originEpoch: client.originEpoch, target: target as Slot["target"], n };
  client.send({ t: "cmd", slot, floor: n, inc, cmd, ...(via ? { via } : {}) } as Message);
  const msg = await client.wait(isResultOrRetry(slot), `cmd ${target}#${n}`);
  if (msg.t === "cmd.retry") throw new Error(`unexpected cmd.retry for ${target}#${n} (expected inc ${msg.inc})`);
  return msg;
}

describe("M6-10b: plugin parity after 2.x import", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
  });

  it("loads every built-in's panels/views and commands, keeps imported user plugins read-only until plugin.grant, and enforces request-tier grants", async () => {
    const root = testRoot("m6-10b-parity-plugins");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const src = join(root, "v2");
    const dataDir = join(root, "v3");
    const outDir = join(desktop, "out");
    const builtInsDir = join(outDir, "builtin-plugins");

    const fx = make2xFolder(src);

    // Give the fixture's user plugin (sample-plugin) real web + host parts, a panel, a command, and
    // a host activation check that reads the 2.x plugin-data/sample-plugin/state.json copied by M6-03a.
    const sampleSrcDir = join(src, "plugins", fx.pluginName);
    const samplePkg = JSON.parse(readFileSync(join(sampleSrcDir, "package.json"), "utf8")) as {
      ccb: Record<string, unknown>;
      [key: string]: unknown;
    };
    samplePkg.ccb.contributes = {
      ...(samplePkg.ccb.contributes as Record<string, unknown>),
      panels: [{ id: "sample-plugin.panel", title: "Sample Panel" }],
      commands: [{ id: "sample-plugin.readState", title: "Read Sample State" }],
    };
    writeFileSync(join(sampleSrcDir, "package.json"), JSON.stringify(samplePkg, null, 2));
    writeFileSync(
      join(sampleSrcDir, "web.js"),
      'export function activate() { return { plugin: "sample-plugin", loaded: true }; }\n',
    );
    writeFileSync(
      join(sampleSrcDir, "host.js"),
      `import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function activate(ccb) {
  const statePath = join(ccb.storage.dir, "state.json");
  const initial = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(join(ccb.storage.dir, "started.json"), JSON.stringify({
    storageDir: ccb.storage.dir,
    count: initial.count,
    greeting: ccb.settings.get("greeting"),
  }));
  ccb.commands.register("sample-plugin.readState", () => {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      storageDir: ccb.storage.dir,
      count: state.count,
      greeting: ccb.settings.get("greeting"),
    };
  });
}
`,
    );

    // Add a request-tier user plugin (asks composer -> chat.send).
    const reqPluginName = "request-helper";
    const reqSrcDir = join(src, "plugins", reqPluginName);
    mkdirSync(reqSrcDir, { recursive: true });
    writeFileSync(
      join(reqSrcDir, "package.json"),
      JSON.stringify({
        name: reqPluginName,
        displayName: "Request Helper",
        version: "1.0.0",
        engines: { ccb: "^2.0.0" },
        ccb: {
          permissions: ["composer"],
          web: "web.js",
          contributes: {
            panels: [{ id: "request-helper.panel", title: "Request Panel" }],
          },
        },
      }, null, 2),
    );
    writeFileSync(join(reqSrcDir, "web.js"), 'export function activate() { return { plugin: "request-helper" }; }\n');

    const pluginsJsonPath = join(src, "plugins.json");
    const rawPluginsJson = JSON.parse(readFileSync(pluginsJsonPath, "utf8")) as {
      installed: Record<string, string>;
      [key: string]: unknown;
    };
    rawPluginsJson.installed[reqPluginName] = "local";
    writeFileSync(pluginsJsonPath, JSON.stringify(rawPluginsJson, null, 2));

    const sampleHash = folderHash(sampleSrcDir);
    const reqHash = folderHash(reqSrcDir);
    const srcTreeBefore = treeSnapshot(src);

    const imported = await runImport({
      sourceDir: src,
      targetDir: dataDir,
      dryRun: false,
      builtInsDir,
    });
    expect(imported.problems).toEqual([]);
    expect(imported.reportText).toContain("sample-plugin");
    expect(imported.reportText).toContain("approve to restore");
    expect(imported.reportText).toContain("plugins: 17 (2 read only until you approve them)");
    expect(existsSync(join(dataDir, "plugin-secrets.json"))).toBe(false);
    expect(imported.reportText).toContain("request-helper");
    // B-20(a): each imported third-party plugin has its own "approve to restore" line; no built-in has one.
    for (const name of [fx.pluginName, reqPluginName]) {
      expect(reportPluginLine(imported.reportText, name), `${name} report line`).toMatch(/· approve to restore$/);
    }
    for (const name of EXPECTED_BUILTINS) {
      const line = reportPluginLine(imported.reportText, name);
      expect(line, `${name} report line`).toBeDefined();
      expect(line, `${name} report line`).not.toContain("approve to restore");
    }

    // The 2.x folder is left exactly as it was (no file added, removed or touched).
    expect(treeSnapshot(src)).toEqual(srcTreeBefore);

    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir,
    });
    cleanups.push(() => daemon.stop());

    const client = new ScriptClient("m6-10b");
    cleanups.push(() => client.close());
    await client.connect(daemon.paths.socket, daemon.token);
    await client.sub(client.srv);
    const srvSnap = await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === client.srv, "srv snap");
    const srvInc = srvSnap.logId;
    let srvN = 0;

    const mainBotId = mainBotOf(dataDir);
    const botStream = `bot:${mainBotId}`;
    await client.sub(botStream);
    await client.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === botStream, "bot snap");
    let botN = 0;

    // 1. Every built-in's panels/views and commands load in the core's plugin view and work.
    const builtinManifests = readBuiltinManifests(builtInsDir);
    expect(builtinManifests.map((b) => b.name)).toEqual([...EXPECTED_BUILTINS]);

    const view = await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return null;
      const v = res.result as PluginsView;
      if (!v.host.running) return null;
      for (const b of builtinManifests) {
        const entry = v.plugins.find((p) => p.name === b.name);
        if (!entry) return null;
        if (b.hasHost) {
          for (const cmdId of b.commands) {
            if (!entry.commands.some((c) => c.id === cmdId && c.registered)) return null;
          }
        }
      }
      return v;
    }, { timeout: 20_000, what: "all built-ins loaded and host commands registered" });

    expect(view.host.problem).toBeNull();
    expect(view.broken).toEqual([]);
    expect(view.keybindings).toContainEqual({ command: "ccb-latex.insert", key: "Mod+Shift+M", plugin: "ccb-latex", title: "Insert inline formula" });
    expect(view.keybindings).toContainEqual({ command: "botling.terminal.toggle", key: "Mod+J", plugin: "botling.terminal", title: "Toggle terminal" });

    const webSpecs = okResult<{ specs: WebPluginSpecView[] }>(await reqLarge(client, { type: "plugins.web" })).specs;
    const allViewEntries = [
      ...(view.mainTabs ?? []), ...(view.bottomPanels ?? []), ...(view.chatHeaderViews ?? []),
      ...(view.rightPanelSections ?? []), ...(view.settingsSections ?? []), ...(view.quickSettings ?? []), ...(view.takeovers ?? []),
    ];

    for (const b of builtinManifests) {
      const entry = view.plugins.find((p) => p.name === b.name);
      expect(entry, `${b.name} in plugins.list`).toBeDefined();
      expect(entry?.builtIn, `${b.name} builtIn`).toBe(true);
      expect(entry?.enabled, `${b.name} enabled`).toBe(true);
      expect(entry?.failure, `${b.name} failure`).toBeNull();
      expect(entry?.grant, `${b.name} grant`).toBe("write");

      for (const cmdId of b.commands) {
        const cmdEntry = entry?.commands.find((c) => c.id === cmdId);
        expect(cmdEntry, `${b.name} command ${cmdId}`).toBeDefined();
        if (b.hasHost) expect(cmdEntry?.registered, `${cmdId} registered`).toBe(true);
      }
      for (const panelId of b.panels) {
        expect(entry?.panels.some((p) => p.id === panelId), `${b.name} panel ${panelId}`).toBe(true);
      }
      for (const vEntry of b.views) {
        expect(
          allViewEntries.some((item) => item.plugin === b.name && item.id === vEntry.id),
          `${b.name} view ${vEntry.id} (${vEntry.where})`,
        ).toBe(true);
        if (b.hasWeb) {
          const panelRes = okResult<{ title: string; source: string }>(
            await reqLarge(client, { type: "plugins.panel", name: b.name, panel: vEntry.id }),
          );
          expect(panelRes.source, `${b.name} panel ${vEntry.id} source`).toContain("activate");
        }
      }
      for (const slashName of b.slash) {
        expect(view.slash?.some((s) => s.plugin === b.name && s.name === slashName), `${b.name} /${slashName}`).toBe(true);
      }
      if (b.hasWeb) {
        const spec = webSpecs.find((s) => s.name === b.name);
        expect(spec, `${b.name} in plugins.web`).toBeDefined();
        expect(spec?.builtIn).toBe(true);
        expect(spec?.source).toContain("activate");
      }
    }

    // Exercise real built-in commands and exposed host methods so none pass by doing nothing.
    const toggleRes = await sendCmd(client, client.srv, ++srvN, srvInc, { type: "plugins.command", id: "botling.terminal.toggle" });
    expect(toggleRes.outcome.kind).toBe("applied");

    const shellsRes = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugins.call",
      name: "botling.terminal",
      method: "terminal",
      params: { type: "shells" },
      from: "frame",
    });
    expect(shellsRes.outcome.kind).toBe("applied");
    expect((shellsRes.outcome as { kind: "applied"; result: { result: { shells: string[] } } }).result.result.shells.length).toBeGreaterThan(0);

    const routinesRes = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugins.call",
      name: "botling.routines",
      method: "list",
      params: { botId: mainBotId },
      from: "frame",
    });
    expect(routinesRes.outcome.kind).toBe("applied");

    const usageRes = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugins.call",
      name: "botling.usage",
      method: "turn",
      params: {},
      from: "frame",
    });
    expect(usageRes.outcome.kind).toBe("applied");

    // 2. The fixture's user plugin (sample-plugin): web part loads; program part is off with the M5-18a notice.
    const sampleBefore = view.plugins.find((p) => p.name === fx.pluginName)!;
    expect(sampleBefore).toBeDefined();
    expect(sampleBefore.builtIn).toBeUndefined();
    expect(sampleBefore.enabled).toBe(true);
    expect(sampleBefore.grant).toBe("none");
    expect(sampleBefore.failure).toBe(HELD_BACK_NOTICE);
    expect(sampleBefore.panels).toEqual([{ id: "sample-plugin.panel", title: "Sample Panel" }]);
    expect(sampleBefore.commands).toEqual([{ id: "sample-plugin.readState", title: "Read Sample State", registered: false }]);

    const sampleWeb = webSpecs.find((s) => s.name === fx.pluginName);
    expect(sampleWeb?.builtIn).toBeUndefined();
    expect(sampleWeb?.source).toContain("sample-plugin");
    const samplePanel = okResult<{ title: string; source: string }>(
      await reqLarge(client, { type: "plugins.panel", name: fx.pluginName, panel: "sample-plugin.panel" }),
    );
    expect(samplePanel.title).toBe("Sample Panel");
    expect(samplePanel.source).toContain("sample-plugin");

    const sampleDataDir = join(dataDir, "plugin-data", fx.pluginName);
    expect(existsSync(join(sampleDataDir, "state.json"))).toBe(true);
    expect(existsSync(join(sampleDataDir, "started.json"))).toBe(false);
    const readBeforeGrant = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugins.command",
      id: "sample-plugin.readState",
    });
    expect(readBeforeGrant.outcome.kind).toBe("refused");
    // Its program part did not run at all before the grant (activate() writes started.json first).
    expect(existsSync(join(sampleDataDir, "started.json"))).toBe(false);

    // 3. After `plugin.grant{tier: "write"}` from the local window, its program part starts and reads
    // the data folder copied by M6-03a (not the 2.x source folder).
    const grantWrite = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugin.grant",
      plugin: fx.pluginName,
      codeHash: sampleHash,
      tier: "write",
      reads: [],
      requests: [],
    });
    expect(grantWrite.outcome.kind).toBe("applied");

    await until(async () => {
      const res = await client.req({ type: "plugins.list" });
      if (!res.ok) return false;
      const entry = (res.result as PluginsView).plugins.find((p) => p.name === fx.pluginName);
      return entry?.failure === null && entry.grant === "write" && entry.commands[0]?.registered === true;
    }, { timeout: 10_000, what: "sample-plugin started after write grant" });

    await until(() => existsSync(join(sampleDataDir, "started.json")), { timeout: 10_000, what: "sample-plugin started.json" });
    const startedPayload = JSON.parse(readFileSync(join(sampleDataDir, "started.json"), "utf8")) as {
      storageDir: string;
      count: number;
      greeting: string;
    };
    expect(realpathSync(startedPayload.storageDir)).toBe(realpathSync(sampleDataDir));
    expect(realpathSync(startedPayload.storageDir)).not.toBe(realpathSync(join(src, "plugin-data", fx.pluginName)));
    expect(startedPayload.count).toBe(1);
    expect(startedPayload.greeting).toBe("hello");

    const readAfterGrant = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugins.command",
      id: "sample-plugin.readState",
    });
    expect(readAfterGrant.outcome.kind).toBe("applied");
    const cmdPayload = (readAfterGrant.outcome as { kind: "applied"; result: { result: { storageDir: string; count: number; greeting: string } } }).result.result;
    expect(realpathSync(cmdPayload.storageDir)).toBe(realpathSync(sampleDataDir));
    expect(cmdPayload.count).toBe(1);
    expect(cmdPayload.greeting).toBe("hello");

    // 4. A request-tier plugin's command is refused `grant` before the grant and applied after (within its granted tier).
    const reqPanel = okResult<{ title: string; source: string }>(
      await reqLarge(client, { type: "plugins.panel", name: reqPluginName, panel: "request-helper.panel" }),
    );
    expect(reqPanel.source).toContain("request-helper");

    const reqVia: Via = { plugin: reqPluginName, codeHash: reqHash };
    const refusedBefore = await sendCmd(
      client,
      botStream,
      ++botN,
      srvInc,
      { type: "chat.send", botId: mainBotId, text: "before request grant" },
      reqVia,
    );
    expect(refusedBefore.outcome).toEqual({
      kind: "refused",
      reason: "grant",
      detail: expect.stringContaining(`${reqPluginName} may not do this`),
    });

    const grantRequest = await sendCmd(client, client.srv, ++srvN, srvInc, {
      type: "plugin.grant",
      plugin: reqPluginName,
      codeHash: reqHash,
      tier: "request",
      reads: [],
      requests: ["chat.send"],
    });
    expect(grantRequest.outcome.kind).toBe("applied");

    const appliedAfter = await sendCmd(
      client,
      botStream,
      ++botN,
      srvInc,
      { type: "chat.send", botId: mainBotId, text: "after request grant" },
      reqVia,
    );
    expect(appliedAfter.outcome.kind).toBe("applied");

    // An ungranted command outside its granted requests stays refused `grant`.
    const ungrantedCmd = await sendCmd(
      client,
      botStream,
      ++botN,
      srvInc,
      { type: "chat.react", botId: mainBotId, messageId: "m1", emoji: "👍", present: true },
      reqVia,
    );
    expect(ungrantedCmd.outcome).toEqual({
      kind: "refused",
      reason: "grant",
      detail: expect.stringContaining(`${reqPluginName} may not do this`),
    });

    await until(() => {
      const entries = client.entriesOf(botStream);
      const hasAfter = entries.some((e) => e.kind === "message.added" && JSON.stringify(e.body).includes("after request grant"));
      const hasBefore = entries.some((e) => e.kind === "message.added" && JSON.stringify(e.body).includes("before request grant"));
      expect(hasBefore).toBe(false);
      return hasAfter;
    }, { timeout: 10_000, what: "request-helper chat.send entry in bot log" });
  }, 60_000);
});

