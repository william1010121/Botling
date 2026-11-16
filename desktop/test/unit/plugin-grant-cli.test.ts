// Botling 3 M5-14c: `botlingd plugins` and `botlingd plugins grant <name> --tier …` over the local admin socket.
// An in-process botlingd on a temp data folder (never a real one) with real plugin folders under <data>/plugins; the CLI
// functions are driven through AdminClient exactly as main.ts does, and the built main.cjs is run (async, so the
// in-process server keeps answering) for the exit codes. No window, no focus.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AdminOp } from "../../src/protocol";
import { AuditRow, PluginRow } from "../../src/protocol/table-rows";
import { Botlingd } from "../../src/server/botlingd";
import { AdminClient } from "../../src/server/pairing";
import { grantTierAt, PluginAdmin } from "../../src/server/plugin-admin";
import type { CmdBody } from "../../src/protocol";
import type { Db } from "../../src/server/store";
import { pluginsCommand } from "../../src/server/plugin-cli";
import { botlingdEnv, botlingdScript, testRoot } from "../botlingd-harness";
import { desktop } from "../helpers";

const root = testRoot("plugin-grant-cli");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

let folders = 0;

function writePlugin(plugins: string, name: string, permissions: string[]): void {
  const folder = join(plugins, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { permissions, web: "dist/web.js" } }));
  writeFileSync(join(folder, "dist", "web.js"), `export function activate() { return "${name}"; }\n`);
}

interface Rows { key: string; body: unknown }

function readRows(dataDir: string, stream: string): Rows[] {
  const db = new DatabaseSync(join(dataDir, "server.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    return (db.prepare("SELECT key, body FROM rows WHERE stream = ? AND deleted = 0 ORDER BY rev").all(stream) as Array<{ key: string; body: string }>)
      .map((row) => ({ key: row.key, body: JSON.parse(row.body) }));
  } finally {
    db.close();
  }
}

interface Setup {
  dataDir: string;
  stream: string;
  /** Runs the CLI function with `args`; resolves with its exit code and the lines it printed. */
  cli(args: string[]): Promise<{ code: number; lines: string[] }>;
  plugin(name: string): PluginRow;
  audits(): Array<ReturnType<typeof AuditRow.parse>>;
  hash(name: string): string;
}

async function start(plugins: Record<string, string[]>): Promise<Setup> {
  const dataDir = join(root, `d${++folders}`);
  for (const [name, permissions] of Object.entries(plugins)) writePlugin(join(dataDir, "plugins"), name, permissions);
  const daemon = await Botlingd.start({
    env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }),
    outDir: join(desktop, "out"),
  });
  cleanups.push(() => daemon.stop());
  const client = await AdminClient.connect(daemon.paths.socket, daemon.token);
  cleanups.push(() => client.close());
  const stream = `srv:${daemon.serverId}`;
  const plugin = (name: string) => PluginRow.parse(readRows(dataDir, stream).find((row) => row.key === `plugin:${name}`)?.body);
  // The plugin rows are written after start (syncPlugins); wait for the ones this test installed.
  for (let waited = 0; Object.keys(plugins).some((name) => !readRows(dataDir, stream).some((row) => row.key === `plugin:${name}`)); waited += 25) {
    if (waited > 20_000) throw new Error("plugin rows were not written");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return {
    dataDir,
    stream,
    cli: async (args) => {
      const lines: string[] = [];
      const code = await pluginsCommand(client, { out: (line) => lines.push(line), ask: async () => null }, args);
      return { code, lines };
    },
    plugin,
    audits: () => readRows(dataDir, stream).filter((row) => row.key.startsWith("audit:") && (row.body as { act?: string }).act === "plugin.grant").map((row) => AuditRow.parse(row.body)),
    hash: (name) => plugin(name).codeHash,
  };
}

describe("M5-14c: botlingd plugins / plugins grant (in-process botlingd, temp data folder)", () => {
  it("1. plugins grant my-tool --tier read: grants[codeHash] is read, grantedBy user, one audit row", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const hash = s.hash("my-tool");
    expect(s.plugin("my-tool").grants).toEqual({});

    const run = await s.cli(["grant", "my-tool", "--tier", "read"]);
    expect(run).toEqual({ code: 0, lines: [`my-tool may now: Read only (code ${hash.slice(0, 8)}).`] });

    const row = s.plugin("my-tool");
    expect(Object.keys(row.grants)).toEqual([hash]);
    expect(row.grants[hash]).toMatchObject({ tier: "read", reads: [], requests: [], grantedBy: "user" });
    const audits = s.audits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ act: "plugin.grant", name: "my-tool", member: "desktop", hash, reason: "tier read" });
  }, 60_000);

  it("1b. request: carries the manifest's asks; write is above what a request-tier plugin asks", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const hash = s.hash("my-tool");
    const request = await s.cli(["grant", "my-tool", "--tier", "request"]);
    expect(request).toEqual({ code: 0, lines: [`my-tool may now: Send what it asks for (code ${hash.slice(0, 8)}).`] });
    expect(s.plugin("my-tool").grants[hash]).toMatchObject({ tier: "request", requests: ["chat.send"], grantedBy: "user" });
    const above = await s.cli(["grant", "my-tool", "--tier", "write"]);
    expect(above).toEqual({ code: 1, lines: ["not granted: above what the plugin asks"] });
    expect(s.plugin("my-tool").grants[hash]!.tier).toBe("request");
    expect(s.audits()).toHaveLength(1);
  }, 60_000);

  it("2. a tier above the manifest's ask: not granted, nothing written, no audit row", async () => {
    const s = await start({ "ro-tool": [] });
    const before = readRows(s.dataDir, s.stream);
    const run = await s.cli(["grant", "ro-tool", "--tier", "request"]);
    expect(run).toEqual({ code: 1, lines: ["not granted: above what the plugin asks"] });
    expect(s.plugin("ro-tool").grants).toEqual({});
    expect(s.audits()).toHaveLength(0);
    expect(readRows(s.dataDir, s.stream)).toEqual(before);
  }, 60_000);

  it("3. plugins lists one line per plugin in the exact format, tier words as M5-14b", async () => {
    const s = await start({ "my-tool": ["composer"], "ro-tool": [], "wr-tool": ["files"] });
    await s.cli(["grant", "my-tool", "--tier", "request"]);
    await s.cli(["grant", "wr-tool", "--tier", "write"]);
    const { code, lines } = await s.cli([]);
    expect(code).toBe(0);
    const short = (name: string) => s.hash(name).slice(0, 8);
    expect(lines).toContain(`my-tool  Send what it asks for  (code ${short("my-tool")})`);
    expect(lines).toContain(`ro-tool  Not allowed  (code ${short("ro-tool")})`);
    expect(lines).toContain(`wr-tool  Change its own data on the server  (code ${short("wr-tool")})`);
    // Built-in plugins carry their fixed write grant; every line has the same shape.
    expect(lines.every((line) => /^\S+  (Read only|Send what it asks for|Change its own data on the server|Not allowed)  \(code [0-9a-f]{8}\)$/.test(line))).toBe(true);
    expect(lines.some((line) => line.startsWith("ccb-latex  Change its own data on the server  "))).toBe(true);
    expect(lines).toEqual([...lines].sort((a, b) => (a.split("  ")[0]! < b.split("  ")[0]! ? -1 : 1)));
  }, 60_000);

  it("4. an unknown plugin or an unknown tier: the texts and exit 2, nothing written", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const before = readRows(s.dataDir, s.stream);
    expect(await s.cli(["grant", "nope", "--tier", "read"])).toEqual({ code: 2, lines: ['no plugin named "nope" on this machine'] });
    expect(await s.cli(["grant", "my-tool", "--tier", "root"])).toEqual({ code: 2, lines: ['unknown tier "root" (use read, request or write)'] });
    // none exists on the wire for a later sheet, but this command takes only the three words the card names.
    expect(await s.cli(["grant", "my-tool", "--tier", "none"])).toEqual({ code: 2, lines: ['unknown tier "none" (use read, request or write)'] });
    expect(readRows(s.dataDir, s.stream)).toEqual(before);
  }, 60_000);

  it("4b. no name, no tier or another word after plugins: a usage line and exit 2", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const usage = "usage: botlingd plugins [grant <name> --tier read|request|write]";
    expect(await s.cli(["grant"])).toEqual({ code: 2, lines: [usage] });
    expect(await s.cli(["grant", "my-tool"])).toEqual({ code: 2, lines: [usage] });
    expect(await s.cli(["grant", "--tier", "read"])).toEqual({ code: 2, lines: [usage] });
    expect(await s.cli(["revoke", "my-tool"])).toEqual({ code: 2, lines: [usage] });
  }, 60_000);

  it("5. prototype names are plain unknown plugins (the lookup is by row key, never by object key)", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const before = readRows(s.dataDir, s.stream);
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "plugin:my-tool", "my-tool/../x"]) {
      expect(await s.cli(["grant", name, "--tier", "read"])).toEqual({ code: 2, lines: [`no plugin named "${name}" on this machine`] });
    }
    expect(readRows(s.dataDir, s.stream)).toEqual(before);
  }, 60_000);

  it("6. a grant for `my` never touches `my.plugin` (names may contain dots), and the other way round", async () => {
    const s = await start({ my: ["composer"], "my.plugin": ["composer"] });
    const mine = s.hash("my");
    const dotted = s.hash("my.plugin");
    expect(await s.cli(["grant", "my", "--tier", "request"])).toEqual({ code: 0, lines: [`my may now: Send what it asks for (code ${mine.slice(0, 8)}).`] });
    expect(Object.keys(s.plugin("my").grants)).toEqual([mine]);
    expect(s.plugin("my.plugin").grants).toEqual({});
    expect(s.audits().map((audit) => audit.name)).toEqual(["my"]);

    expect(await s.cli(["grant", "my.plugin", "--tier", "read"])).toEqual({ code: 0, lines: [`my.plugin may now: Read only (code ${dotted.slice(0, 8)}).`] });
    expect(s.plugin("my").grants[mine]!.tier).toBe("request");
    expect(s.plugin("my.plugin").grants[dotted]!.tier).toBe("read");
    expect(s.audits().map((audit) => audit.name)).toEqual(["my", "my.plugin"]);
  }, 60_000);

  it("7. a built-in plugin's grant is fixed in 3.0: the CLI prints M5-14a's refusal and changes nothing", async () => {
    const s = await start({});
    const before = s.plugin("ccb-latex");
    expect(before.grants[before.codeHash]).toMatchObject({ grantedBy: "builtin", tier: "write" });
    expect(await s.cli(["grant", "ccb-latex", "--tier", "read"])).toEqual({ code: 1, lines: ["not granted: built-in"] });
    expect(s.plugin("ccb-latex")).toEqual(before);
    expect(s.audits()).toHaveLength(0);
  }, 60_000);

  it("4c. (review) one name and one --tier only: another word, a second --tier or a flag is the usage line, nothing granted", async () => {
    const s = await start({ my: ["composer"], "my-tool": ["composer"] });
    const before = readRows(s.dataDir, s.stream);
    const usage = "usage: botlingd plugins [grant <name> --tier read|request|write]";
    for (const args of [
      ["grant", "my", "tool", "--tier", "read"],
      ["grant", "my-tool", "--tier", "read", "--tier", "write"],
      ["grant", "my-tool", "--tier", "read", "--json"],
      ["grant", "--tier", "read", "--json"],
      ["grant", "--json", "--tier", "read"],
    ]) expect(await s.cli(args)).toEqual({ code: 2, lines: [usage] });
    expect(readRows(s.dataDir, s.stream)).toEqual(before);
    // Either order is the same grant.
    expect(await s.cli(["grant", "--tier", "read", "my-tool"])).toEqual({ code: 0, lines: [`my-tool may now: Read only (code ${s.hash("my-tool").slice(0, 8)}).`] });
  }, 60_000);

  it("4d. (review) a name or tier with a line break or terminal escape is echoed escaped on one line; a name no row can have is exit 2", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const before = readRows(s.dataDir, s.stream);
    const fake = "evil\nmy-tool may now: Change its own data on the server (code deadbeef).";
    expect(await s.cli(["grant", fake, "--tier", "read"])).toEqual({ code: 2, lines: ['no plugin named "evil\\u000amy-tool may now: Change its own data on the server (code deadbeef)." on this machine'] });
    expect(await s.cli(["grant", "\u001b]0;x\u0007\u202e", "--tier", "read"])).toEqual({ code: 2, lines: ['no plugin named "\\u001b]0;x\\u0007\\u202e" on this machine'] });
    expect(await s.cli(["grant", "my-tool", "--tier", "read\r"])).toEqual({ code: 2, lines: ['unknown tier "read\\u000d" (use read, request or write)'] });
    // Over the wire's 200 characters: still "no plugin named" and exit 2, not a malformed-request error.
    const long = "x".repeat(201);
    expect(await s.cli(["grant", long, "--tier", "read"])).toEqual({ code: 2, lines: [`no plugin named "${long}" on this machine`] });
    expect(readRows(s.dataDir, s.stream)).toEqual(before);
  }, 60_000);

  it("8. the built botlingd: exit codes and the same lines over the real socket", async () => {
    const s = await start({ "my-tool": ["composer"] });
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--no-warnings", botlingdScript, "plugins", ...args], { env: botlingdEnv(s.dataDir), stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    const hash = s.hash("my-tool");
    expect(await run(["grant", "my-tool", "--tier", "read"])).toMatchObject({ code: 0, stdout: `my-tool may now: Read only (code ${hash.slice(0, 8)}).\n` });
    expect((await run([])).stdout).toContain(`my-tool  Read only  (code ${hash.slice(0, 8)})\n`);
    expect(await run(["grant", "nope", "--tier", "read"])).toMatchObject({ code: 2, stdout: 'no plugin named "nope" on this machine\n' });
    expect(await run(["grant", "my-tool", "--tier", "x"])).toMatchObject({ code: 2, stdout: 'unknown tier "x" (use read, request or write)\n' });
    expect(s.audits()).toHaveLength(1);
  }, 90_000);
});

describe("M5-14c: wire and own-property checks", () => {
  it("9. AdminOp takes plugins.list and plugins.grant{plugin, tier} and nothing else", () => {
    expect(AdminOp.safeParse({ op: "plugins.list" }).success).toBe(true);
    for (const tier of ["none", "read", "request", "write"]) {
      expect(AdminOp.safeParse({ op: "plugins.grant", plugin: "my.plugin", tier }).success).toBe(true);
    }
    expect(AdminOp.safeParse({ op: "plugins.grant", plugin: "my", tier: "root" }).success).toBe(false);
    expect(AdminOp.safeParse({ op: "plugins.grant", plugin: "my" }).success).toBe(false);
    expect(AdminOp.safeParse({ op: "plugins.grant", plugin: "my", tier: "read", codeHash: "a" }).success).toBe(false);
    expect(AdminOp.safeParse({ op: "plugins.list", extra: 1 }).success).toBe(false);
  });

  it("9b. (review) a manifest that lists plugin.grant: the grant sent leaves it out (D54) and keeps the rest; local scope, no via", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE rows (stream TEXT, key TEXT, body TEXT, deleted INTEGER, rev INTEGER); CREATE TABLE streams (stream TEXT, logId TEXT)");
    const manifest = { tier: "request", reads: ["bots"], requests: ["chat.send", "plugin.grant"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
    db.prepare("INSERT INTO rows VALUES ('srv:S', 'plugin:p', ?, 0, 1)").run(JSON.stringify({ codeHash: "H1", manifest, author: "user", grants: {} }));
    db.prepare("INSERT INTO streams VALUES ('srv:S', 'L1')").run();
    const sent: Array<{ body: CmdBody; scope: unknown }> = [];
    const admin = new PluginAdmin({
      serverId: "S",
      reader: () => ({ prepare: (sql: string) => db.prepare(sql) }) as unknown as Db,
      runtime: { receive: async (body, options) => { sent.push({ body, scope: options?.scope }); return { status: "result", fresh: true, message: { outcome: { kind: "applied" } } } as never; } },
    });
    expect(await admin.grant("p", "request")).toEqual({ ok: true, name: "p", codeHash: "H1", tier: "request" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.scope).toBe("local");
    expect(sent[0]!.body.via).toBeUndefined();
    expect(sent[0]!.body).toMatchObject({ slot: { origin: "desktop", target: "srv:S", n: 1 }, floor: 1, inc: "L1" });
    expect(sent[0]!.body.cmd).toEqual({ type: "plugin.grant", plugin: "p", codeHash: "H1", tier: "request", reads: ["bots"], requests: ["chat.send"] });
    expect(await admin.grant("q", "read")).toEqual({ ok: false, reason: "no-plugin" });
    expect(sent).toHaveLength(1);
    // A row whose body is not JSON is left out of the list; it does not hide the others.
    db.prepare("INSERT INTO rows VALUES ('srv:S', 'plugin:bad', '{not json', 0, 2)").run();
    expect(admin.list()).toEqual([{ name: "p", codeHash: "H1", tier: "none", asks: "request" }]);
    db.close();
  });

  it("10. grantTierAt looks the hash up as an own key: prototype names with no record give none, an older record shows installed", () => {
    const manifest = { tier: "write" as const, reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
    const grant = { tier: "request" as const, reads: [], requests: [], grantedBy: "user" as const, at: 1 };
    const row = (codeHash: string, grants: Record<string, typeof grant>) => ({ codeHash, manifest, author: "user" as const, grants });
    expect(grantTierAt(row("H1", { H1: grant }))).toBe("request");
    // 2026-11-16: an installed plugin whose record is at an older hash is shown as installed ("write"), not "none".
    expect(grantTierAt(row("H2", { H1: grant }))).toBe("write");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(grantTierAt(row(name, {}))).toBe("none");
    }
    const own = JSON.parse(`{"__proto__": ${JSON.stringify(grant)}}`) as Record<string, typeof grant>;
    expect(grantTierAt(row("__proto__", own))).toBe("request");
  });
});
