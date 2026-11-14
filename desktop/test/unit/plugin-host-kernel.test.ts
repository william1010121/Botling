// @vitest-environment node
// The plugin host on the plugin kernel (Web/host/src/host.ts, kernel step 1 step 5): an `activate` that registers after
// its plugin's unload leaves nothing behind; a throwing, rejecting or hanging disposer does not stop the others and is
// reported once (`unloadFailed` in the next load answer); an async disposer is waited for before the new code loads;
// dependents unload first and load after what they require. 2.x plugins (no declarations, synchronous disposers) see the
// host as before: the existing plugin-host / plugin-api tests and the step-1 goldens guard that.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Host, type CcbHost, type HostOptions, type HostPluginSpec } from "../../../Web/host/src/host";
import { deferred, flush, manualTimers } from "../kernel-driver";

const scratch = mkdtempSync(join(tmpdir(), "host-kernel-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const spec = (name: string, overrides: Partial<HostPluginSpec> = {}): HostPluginSpec =>
  ({ name, version: "1.0.0", main: "", fingerprint: "1", settings: {}, storageDir: join(scratch, name), ...overrides });

function makeHost(plugins: Record<string, (ccb: CcbHost) => unknown>, options: HostOptions = {}) {
  const written: any[] = [];
  const host = new Host((message) => written.push(message), async (s) => plugins[s.name] as any, options);
  const registered = () => written.filter((message) => message.method === "registered").at(-1)?.params;
  return { host, written, registered };
}

describe("the plugin host on the kernel", () => {
  it("an activate that registers after its plugin was unloaded leaves nothing behind", async () => {
    const gate = deferred();
    const world = new Set<string>();
    const { host, written, registered } = makeHost({
      slow: async (ccb) => {
        world.add("early");
        ccb.subscriptions.push(() => world.delete("early"));
        await gate.promise;
        // Unloaded by now: each of these is undone at once.
        ccb.commands.register("slow.run", () => 1);
        ccb.events.on("chatRead", () => world.add("heard"));
        ccb.ui.expose("slow.method", () => 2);
        world.add("late");
        return () => world.delete("late");
      },
    });
    const loading = host.sync([spec("slow")]);
    await flush();
    await host.sync([]);
    expect(world).toEqual(new Set());
    gate.resolve();
    expect((await loading).loaded).toEqual([]);
    await flush();
    expect(world).toEqual(new Set());
    expect(host.isLoaded("slow")).toBe(false);
    await host.receive({ id: 7, method: "command", params: { id: "slow.run" } });
    expect(written.find((message) => message.id === 7)?.error?.message).toBe('No command "slow.run".');
    await host.receive({ id: 8, method: "event", params: { name: "chatRead", data: {} } });
    expect(world.has("heard")).toBe(false);
    expect(registered()).toEqual({ beforeSend: 0, afterReply: 0, commands: [], exposed: {}, events: [] });
    // And it loads again normally.
    const again = makeHost({ quick: (ccb) => { ccb.commands.register("quick.run", () => 3); } });
    expect((await again.host.sync([spec("quick")])).loaded).toEqual(["quick"]);
  });

  it("what the replaced code's activate registers late never joins the new instance: it is undone at once", async () => {
    const gate = deferred();
    const world = new Set<string>();
    const { host } = makeHost({
      p: async (ccb) => {
        if (ccb.plugin.version === "1.0.0") await gate.promise;
        world.add(ccb.plugin.version);
        return () => world.delete(ccb.plugin.version);
      },
    });
    const first = host.sync([spec("p")]);
    await flush();
    expect((await host.sync([spec("p", { fingerprint: "2", version: "2.0.0" })])).loaded).toEqual(["p"]);
    gate.resolve();
    await first;
    expect(world).toEqual(new Set(["2.0.0"]));
    await host.sync([]);
    expect(world).toEqual(new Set());
  });

  it("a throwing or rejecting disposer does not stop the others, newest first, and is reported once", async () => {
    const ran: string[] = [];
    const { host } = makeHost({
      p: (ccb) => {
        ccb.subscriptions.push(() => { ran.push("subscription"); });
        ccb.commands.register("p.one", () => 1);
        ccb.events.on("chatRead", () => {});
        ccb.hooks.beforeSend(() => undefined);
        // Disposers the plugin's own code returns: two fail.
        return async () => { ran.push("returned"); throw new Error("async cleanup failed"); };
      },
      // (What a pushed subscription throws stays api.ts's own, swallowed there as in 2.x.)
      q: (ccb) => { ccb.subscriptions.push(() => { ran.push("q subscription"); throw new Error("swallowed"); }); return () => { ran.push("q"); throw new Error("sync cleanup failed"); }; },
    });
    await host.sync([spec("p"), spec("q")]);
    const result = await host.sync([]);
    expect(ran).toEqual(["returned", "subscription", "q", "q subscription"]);
    expect(result.loaded).toEqual([]);
    expect(result.unloadFailed).toEqual([
      { name: "q", message: "sync cleanup failed" },
      { name: "p", message: "async cleanup failed" },
    ]);
    expect((await host.sync([])).unloadFailed).toBeUndefined();
  });

  it("a never-settling disposer is marked failed after the time limit; the new code loads then", async () => {
    const timers = manualTimers();
    const activations: string[] = [];
    const { host } = makeHost({
      p: (ccb) => { activations.push(ccb.plugin.version); return () => new Promise(() => {}); },
    }, { timers, undoTimeoutMs: 100 });
    await host.sync([spec("p")]);
    let done = false;
    const reloading = host.sync([spec("p", { fingerprint: "2", version: "2.0.0" })]).then((result) => { done = true; return result; });
    await flush();
    expect([done, activations]).toEqual([false, ["1.0.0"]]);
    timers.advance(100);
    const result = await reloading;
    expect(activations).toEqual(["1.0.0", "2.0.0"]);
    expect(result.loaded).toEqual(["p"]);
    expect(result.unloadFailed).toEqual([{ name: "p", message: "its undo did not finish within 100 ms" }]);
  });

  it("waits for an async disposer before the new code of the same plugin activates", async () => {
    const order: string[] = [];
    const cleanup = deferred();
    const { host } = makeHost({
      p: (ccb) => { order.push(`activate ${ccb.plugin.version}`); return () => { order.push("cleanup starts"); return cleanup.promise.then(() => { order.push("cleanup done"); }); }; },
    });
    await host.sync([spec("p")]);
    const reloading = host.sync([spec("p", { fingerprint: "2", version: "2.0.0" })]);
    await flush();
    expect(order).toEqual(["activate 1.0.0", "cleanup starts"]);
    expect(host.isLoaded("p")).toBe(false);
    cleanup.resolve();
    expect((await reloading).loaded).toEqual(["p"]);
    expect(order).toEqual(["activate 1.0.0", "cleanup starts", "cleanup done", "activate 2.0.0"]);
  });

  it("a disposer taken back early runs once, not again at unload", async () => {
    let runs = 0;
    let off!: () => void;
    const { host } = makeHost({ p: (ccb) => { off = ccb.events.on("chatRead", () => {}); ccb.subscriptions.push(() => {}); const own = ccb.commands.register("p.x", () => 1); own(); return () => { runs += 1; }; } });
    await host.sync([spec("p")]);
    off();
    await host.sync([]);
    expect(runs).toBe(1);
  });

  it("dependents load after what they require and unload before it (declarations for built-ins)", async () => {
    const order: string[] = [];
    const plugin = (name: string) => (ccb: CcbHost) => { order.push(`activate ${name} ${ccb.plugin.version}`); return () => { order.push(`dispose ${name}`); }; };
    const declarations: HostOptions["declarations"] = (s) =>
      s.name === "chat" ? { provides: { services: ["quote"] } } : s.name === "note" || s.name === "coach" ? { requires: { services: ["quote"] } } : null;
    const { host } = makeHost({ chat: plugin("chat"), note: plugin("note"), coach: plugin("coach"), other: plugin("other") }, { declarations });
    // Asked for before its provider: loaded after it.
    expect((await host.sync([spec("note"), spec("other"), spec("chat"), spec("coach")])).loaded).toEqual(["other", "chat", "coach", "note"]);
    expect(order.splice(0)).toEqual(["activate other 1.0.0", "activate chat 1.0.0", "activate coach 1.0.0", "activate note 1.0.0"]);
    // The provider's new code: its dependents unload first, then it, then all load again.
    const result = await host.sync([spec("note"), spec("other"), spec("chat", { fingerprint: "2", version: "2.0.0" }), spec("coach")]);
    expect(order.splice(0)).toEqual(["dispose note", "dispose coach", "dispose chat", "activate chat 2.0.0", "activate coach 1.0.0", "activate note 1.0.0"]);
    expect(result.loaded.sort()).toEqual(["chat", "coach", "note", "other"]);
    // The provider goes away: its dependents go first and cannot load without it.
    const without = await host.sync([spec("note"), spec("other")]);
    expect(order.splice(0)).toEqual(["dispose note", "dispose coach", "dispose chat"]);
    expect(without.loaded).toEqual(["other"]);
    expect(without.failed).toEqual([{ name: "note", message: 'It requires "quote", which no loaded plugin provides.' }]);
  });
});
