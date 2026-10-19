// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Host, type CcbHost, type HostPluginSpec } from "../src/host";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ccb-host-"));

function spec(name: string, overrides: Partial<HostPluginSpec> = {}): HostPluginSpec {
  return { name, version: "1.0.0", main: "", fingerprint: "1", settings: {}, storageDir: join(scratch, "data", name), ...overrides };
}

/** A host whose plugins are given as functions, and what it wrote. */
function makeHost(plugins: Record<string, (ccb: CcbHost) => unknown>) {
  const written: any[] = [];
  const host = new Host((message) => written.push(message), async (s) => plugins[s.name] as any);
  return { host, written };
}

describe("plugin host (in process)", () => {
  it("beforeSend hooks change or stop what is sent, in order", async () => {
    const { host, written } = makeHost({
      upper: (ccb) => { ccb.hooks.beforeSend((m) => m.text.toUpperCase()); },
      tag: (ccb) => { ccb.hooks.beforeSend((m) => ({ ...m, text: `${m.text}!` })); },
      stop: (ccb) => { ccb.hooks.beforeSend((m) => (m.text.includes("SECRET") ? false : undefined)); },
    });
    await host.sync([spec("upper"), spec("tag"), spec("stop")]);
    await host.receive({ id: 1, method: "beforeSend", params: { bot: { id: "b" }, text: "hi" } });
    await host.receive({ id: 2, method: "beforeSend", params: { bot: { id: "b" }, text: "secret" } });
    expect(written.find((m) => m.id === 1)?.result).toEqual({ text: "HI!" });
    expect(written.find((m) => m.id === 2)?.result).toEqual({ cancel: true, by: "stop" });
    await Promise.resolve();
    expect(written.filter((m) => m.method === "registered").at(-1)?.params.beforeSend).toBe(3);
  });

  it("a hook that throws is reported and skipped", async () => {
    const { host, written } = makeHost({
      bad: (ccb) => { ccb.hooks.beforeSend(() => { throw new Error("boom"); }); },
      good: (ccb) => { ccb.hooks.beforeSend((m) => `${m.text}.`); },
    });
    await host.sync([spec("bad"), spec("good")]);
    await host.receive({ id: 1, method: "beforeSend", params: { bot: {}, text: "a" } });
    expect(written.find((m) => m.id === 1)?.result).toEqual({ text: "a." });
    expect(written).toContainEqual({ method: "pluginError", params: { plugin: "bad", message: "boom" } });
  });

  it("a plugin whose activate throws does not load", async () => {
    const { host } = makeHost({ broken: () => { throw new Error("nope"); } });
    const result = await host.sync([spec("broken")]);
    expect(result.failed).toEqual([{ name: "broken", message: "nope" }]);
    expect(host.isLoaded("broken")).toBe(false);
  });

  it("commands, web calls, storage, settings and reloading", async () => {
    const changes: unknown[] = [];
    const disposed: string[] = [];
    const { host, written } = makeHost({
      tool: (ccb) => {
        ccb.commands.register("tool.add", (a, b) => (a as number) + (b as number));
        ccb.web.handle("echo", (params) => ({ got: params }));
        ccb.storage.set("count", (ccb.storage.get("count") as number ?? 0) + 1);
        ccb.settings.onChange("tool.mode", (value) => changes.push(value));
        return () => disposed.push("tool");
      },
    });
    await host.sync([spec("tool", { settings: { "tool.mode": "a" } })]);
    await host.receive({ id: 1, method: "command", params: { id: "tool.add", args: [2, 3] } });
    await host.receive({ id: 2, method: "web", params: { plugin: "tool", method: "echo", params: 7 } });
    expect(written.find((m) => m.id === 1)?.result).toBe(5);
    expect(written.find((m) => m.id === 2)?.result).toEqual({ got: 7 });

    await host.sync([spec("tool", { settings: { "tool.mode": "b" } })]);
    expect(changes).toEqual(["b"]);
    expect(disposed).toEqual([]);

    // A new version (new fingerprint) reloads it; its storage is still there.
    await host.sync([spec("tool", { fingerprint: "2", settings: { "tool.mode": "b" } })]);
    expect(disposed).toEqual(["tool"]);
    expect(JSON.parse(readFileSync(join(scratch, "data/tool/storage.json"), "utf8"))).toEqual({ count: 2 });
  });

  it("asks ClaudeCodeBot for bots and routines, and answers when ClaudeCodeBot replies", async () => {
    let list: unknown;
    const { host, written } = makeHost({
      lister: async (ccb) => { list = await ccb.bots.list(); },
    });
    const loading = host.sync([spec("lister")]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = written.find((m) => m.method === "bots.list");
    await host.receive({ id: request.id, result: [{ id: "main", name: "Main bot", role: "main", awake: false }] });
    await loading;
    expect(list).toEqual([{ id: "main", name: "Main bot", role: "main", awake: false }]);
  });
});

describe("plugin host (the real Node process)", () => {
  const script = join(scratch, "host.mjs");
  let child: ChildProcessWithoutNullStreams | null = null;

  beforeAll(async () => {
    await build({ entryPoints: [join(here, "../src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", outfile: script });
  });

  afterEach(() => child?.kill());

  it("speaks JSON-RPC on stdin/stdout and keeps plugin logs off stdout", async () => {
    const plugin = join(scratch, "shout.mjs");
    writeFileSync(plugin, `export function activate(ccb) {
      console.log("this goes to stderr");
      ccb.hooks.beforeSend((m) => m.text.replace("cat", "🐈"));
      ccb.notify("ready to shout");
    }`);
    child = spawn(process.execPath, [script], { env: { ...process.env, CCB_PLUGIN_HOST: "1" } });
    const messages: any[] = [];
    const waiters: (() => void)[] = [];
    createInterface({ input: child.stdout }).on("line", (line) => {
      messages.push(JSON.parse(line));
      waiters.splice(0).forEach((wake) => wake());
    });
    const next = async (match: (m: any) => boolean) => {
      while (!messages.some(match)) await new Promise<void>((wake) => waiters.push(wake));
      return messages.find(match);
    };
    const send = (message: unknown) => child!.stdin.write(JSON.stringify(message) + "\n");

    await next((m) => m.method === "ready");
    send({ id: 1, method: "load", params: { plugins: [spec("shout", { main: plugin })] } });
    expect((await next((m) => m.id === 1)).result).toEqual({ loaded: ["shout"], failed: [] });
    expect((await next((m) => m.method === "notify")).params).toEqual({ plugin: "shout", text: "ready to shout" });
    send({ id: 2, method: "beforeSend", params: { bot: { id: "main" }, text: "one cat" } });
    expect((await next((m) => m.id === 2)).result).toEqual({ text: "one 🐈" });
  });
});
