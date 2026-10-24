// The plugin host as a utility process (Phase 4a): the core's launcher asks "main" to start it, gets
// a port, and from then on talks the same JSON-RPC lines. Here "main" and the utility process are
// simulated in-process with paired ports, running Web/host's real Host class as src/host/utility.ts
// does; the e2e plugins test checks the real utility process.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { PluginHostClient } from "../../src/core/plugins/host-client";
import { UtilityHostLauncher, type PortLike } from "../../src/core/plugins/utility-host";
import { Host } from "../../../Web/host/src/host";

/** Two joined ports, delivering asynchronously as MessagePortMain does. */
function channel(): [PortLike & { closed: boolean }, PortLike & { closed: boolean }] {
  const make = () => {
    const listeners: { message: ((event: { data: unknown }) => void)[]; close: (() => void)[] } = { message: [], close: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const port: any = {
      other: null,
      closed: false,
      postMessage(data: unknown) { const other = port.other; if (!port.closed) setTimeout(() => other.listeners.message.forEach((fn: (event: { data: unknown }) => void) => fn({ data })), 0); },
      on(event: "message" | "close", fn: never) { (listeners[event] as unknown[]).push(fn); },
      start() {},
      close() { if (port.closed) return; port.closed = true; port.other.closed = true; setTimeout(() => port.other.listeners.close.forEach((fn: () => void) => fn()), 0); },
      listeners,
    };
    return port;
  };
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b];
}

describe("the plugin host as a utility process", () => {
  it("starts through main, loads a program part, runs its command, and is ended through main", async () => {
    const root = tempDir("utility-host");
    const folder = join(root, "counter");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "host.mjs"), `export function activate(ccb) { ccb.commands.register("counter.count", () => 7); }`);
    const asked: Record<string, unknown>[] = [];
    let launcher!: UtilityHostLauncher;
    let hostPort: (PortLike & { closed: boolean }) | null = null;
    // "Main": starts a Host on one end of a channel and hands the core the other.
    const main = {
      postMessage(message: unknown) {
        const value = message as Record<string, unknown>;
        asked.push(value);
        if (value.op === "start") {
          const [core, host] = channel();
          hostPort = host;
          const instance = new Host((line) => host.postMessage(JSON.stringify(line)));
          host.on("message", (event) => { void instance.receive(JSON.parse(String(event.data))); });
          setTimeout(() => {
            launcher.receive({ botling: "hostStarted", id: value.id, pid: 4242 }, [core]);
            instance.notify("ready", { pid: 4242 });
          }, 5);
        } else if (value.op === "kill") {
          hostPort?.close();
          setTimeout(() => launcher.receive({ botling: "hostExit", id: value.id, code: 0 }), 5);
        }
      },
    };
    launcher = new UtilityHostLauncher(main);
    const client = new PluginHostClient("ignored", { command: "", launch: launcher.launch }, join(root, "data"));
    client.update([{ name: "counter", version: "1.0.0", main: join(folder, "host.mjs"), fingerprint: "1", settings: {}, storageDir: join(root, "data", "counter") }]);
    expect(asked[0]).toMatchObject({ botling: "host", op: "start", id: 1, cwd: join(root, "data") });
    // Only the allow-listed environment goes to main (no BOTLING_*, ELECTRON_*).
    expect(Object.keys(asked[0]!.env as object).every((key) => !key.startsWith("BOTLING_") && !key.startsWith("ELECTRON_"))).toBe(true);
    expect((asked[0]!.env as Record<string, string>).CCB_PLUGIN_HOST).toBe("1");
    await until(() => client.running && client.commands.includes("counter.count"), { what: "the host to load the plugin" });
    expect(client.pid).toBe(4242);
    expect(await client.command("counter.count")).toBe(7);
    await client.shutdown();
    expect(asked.some((value) => value.op === "kill")).toBe(true);
    expect(client.running).toBe(false);
  });

  it("a host that exits is started again, and one main cannot start is reported", async () => {
    const root = tempDir("utility-host");
    let launcher!: UtilityHostLauncher;
    const starts: number[] = [];
    const main = {
      postMessage(message: unknown) {
        const value = message as Record<string, unknown>;
        if (value.op !== "start") return;
        starts.push(value.id as number);
        // The first exits at once; the second fails to start.
        setTimeout(() => launcher.receive(starts.length === 1 ? { botling: "hostExit", id: value.id, code: 9 } : { botling: "hostFailed", id: value.id, error: "no" }), 5);
      },
    };
    launcher = new UtilityHostLauncher(main);
    const failures: string[] = [];
    const client = new PluginHostClient("ignored", { command: "", launch: launcher.launch }, join(root, "data"), () => {}, { hook: 500, call: 500, load: 500, ready: 500, restartDelay: 20 });
    client.onPluginFailure = (_plugin, message) => failures.push(message);
    client.update([{ name: "x", version: "1.0.0", main: join(root, "x.mjs"), fingerprint: "1", settings: {}, storageDir: root }]);
    await until(() => starts.length >= 2, { what: "a restart" });
    await until(() => client.problem?.includes("no"), { what: "the failure to show" });
    expect(failures[0]).toContain("exited (9)");
    client.stop();
  });
});
