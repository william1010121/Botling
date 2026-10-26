// CoreClient's swap ports with Electron's utilityProcess replaced by fakes: requests held while the core
// drains (and released to the new core), the self-check on a scratch folder, and a retired core that is
// not restarted. No Electron, no windows.
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  static all: FakeChild[] = [];
  posted: any[] = [];
  pid = 4242 + FakeChild.all.length;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  answer: ((message: any) => any) | null = null;
  constructor(readonly script: string, readonly env: Record<string, string>) { super(); FakeChild.all.push(this); setImmediate(() => this.emit("spawn")); }
  postMessage(message: any) {
    this.posted.push(message);
    const reply = this.answer?.(message);
    if (reply) setImmediate(() => this.emit("message", reply));
  }
  kill() { setImmediate(() => this.emit("exit", 0)); return true; }
}

vi.mock("electron", () => ({
  utilityProcess: { fork: (script: string, _args: string[], options: { env: Record<string, string> }) => new FakeChild(script, options.env) },
  MessageChannelMain: class { port1 = {}; port2 = {}; },
}));

const { CoreClient } = await import("../../src/main/core-client");
const ok = (id: string) => ({ v: 10, id, ok: true, result: {} });
const answers = (message: any) => (message?.cmd ? ok(message.id) : null);

const dirs: string[] = [];
afterEach(() => { FakeChild.all = []; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function client() {
  const audit: string[] = [];
  const core = new CoreClient({ script: "/old/core/main.cjs", env: { A: "1" }, onEvent: () => {}, audit: (line) => audit.push(line) });
  const scratch = mkdtempSync(join(tmpdir(), "botling-client-swap-"));
  dirs.push(scratch);
  return { core, audit, ports: core.swapPorts(join(scratch, "swap-handover.json"), scratch) };
}

describe("CoreClient during a core swap", () => {
  it("holds what would change something while draining, passes reads, and sends what it held once let go", async () => {
    const { core, ports } = client();
    core.start();
    const old = FakeChild.all[0]!;
    old.answer = answers;
    ports.hold("drain");
    const send = core.request({ type: "chat.send", botId: "b", text: "hello" } as any, "w1.a");
    const read = await core.request({ type: "chat.snapshot" } as any, "w1.b");
    expect(read.ok).toBe(true);
    expect(old.posted.map((message) => message.cmd?.type)).toEqual(["chat.snapshot"]);
    ports.hold("all");
    const alsoHeld = core.request({ type: "chat.snapshot" } as any, "w1.c");
    const cancelled = core.request({ type: "chat.send", botId: "b", text: "never mind" } as any, "w1.d");
    core.cancel("w1.d");
    expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(old.posted.map((message) => message.id)).toEqual(["w1.b"]);
    void send; void alsoHeld;
  });

  it("starts the new core, waits for its answer, and gives it the held requests in order", async () => {
    const { core, ports } = client();
    core.start();
    FakeChild.all[0]!.answer = answers;
    ports.hold("all");
    const first = core.request({ type: "chat.send", botId: "b", text: "one" } as any, "w1.a");
    const second = core.request({ type: "chat.answer", botId: "b", messageId: "m", text: "two" } as any, "w1.b");
    const stopping = ports.stop();
    await stopping;
    // The old core's exit is no crash: nothing restarts it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(FakeChild.all).toHaveLength(1);
    const starting = ports.start("/new/core/main.cjs");
    await new Promise((resolve) => setImmediate(resolve));
    const fresh = FakeChild.all[1]!;
    expect(fresh.script).toBe("/new/core/main.cjs");
    fresh.answer = answers;
    // The first settings.get went before answers were wired: the readiness check asks again.
    expect(await starting).toBeNull();
    expect(ports.script).toBe("/new/core/main.cjs");
    ports.hold("none");
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(fresh.posted.filter((message) => message.cmd && message.cmd.type !== "settings.get").map((message) => message.id)).toEqual(["w1.a", "w1.b"]);
  }, 15_000);

  it("self-checks a build on a scratch folder, apart from the running core", async () => {
    const { core, ports } = client();
    core.start();
    const running = FakeChild.all[0]!;
    const checking = ports.probe("/new/core/main.cjs");
    const probe = FakeChild.all[1]!;
    probe.answer = answers;
    // Answer what it was already sent.
    for (const message of probe.posted) probe.emit("message", ok(message.id));
    expect(await checking).toBeNull();
    expect(probe.env).toMatchObject({ A: "1", BOTLING_CORE_PROBE: "1", BOTLING_IMPORT_FROM: "", BOTLING_ROUTINE_TICK_MS: "0" });
    expect(probe.env.BOTLING_DATA_DIR).toMatch(/core-probe-/);
    expect(running.posted).toEqual([]);
  });

  it("a build that answers in another protocol version or exits fails its self-check", async () => {
    const { core, ports } = client();
    core.start();
    const wrong = ports.probe("/v9/core/main.cjs");
    FakeChild.all[1]!.emit("message", { v: 9, id: "probe.settings", ok: true, result: {} });
    expect(await wrong).toMatch(/protocol 9/);
    const crashing = ports.probe("/crash/core/main.cjs");
    FakeChild.all[2]!.stderr.emit("data", "SyntaxError: Unexpected token");
    FakeChild.all[2]!.emit("exit", 1);
    expect(await crashing).toMatch(/exited \(1\).*SyntaxError/);
  });

  it("asks the core to drain and reads its answer", async () => {
    const { core, ports } = client();
    core.start();
    const child = FakeChild.all[0]!;
    child.answer = (message) => (message.botling === "drain" ? { botling: "drained", id: message.id, ok: true, entries: 3, interrupted: ["b"] } : null);
    expect(await ports.drain(1_000, 100)).toEqual({ ok: true, entries: 3, interrupted: ["b"] });
    expect(child.posted[0]).toMatchObject({ botling: "drain", timeoutMs: 1_000, boundaryMs: 100 });
    ports.undrain();
    expect(child.posted[1]).toEqual({ botling: "undrain" });
  });
});
