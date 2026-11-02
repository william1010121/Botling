// Electron force-ends a utility process about 2 s after `kill()`, so the core's shutdown (which writes the restart
// checkpoint's `ready` last) must not depend on a SIGTERM: main asks for it with a message and waits.
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";

const all: CoreHarness[] = [];
afterEach(async () => { for (const c of all.splice(0)) if (c.child.exitCode === null && c.child.signalCode === null) await c.kill("SIGKILL"); });

it("a quit message runs the whole shutdown: the restart checkpoint is ready and the core exits 0", async () => {
  const dir = tempDir("restart-quit-message");
  const core = new CoreHarness(dir, { BOTLING_ROUTINE_TICK_MS: "0", BOTLING_UPDATE_PENDING: "0", BOTLING_IMPORT_FROM: "" });
  all.push(core);
  await core.call({ type: "chat.send", botId: MAIN, text: "/slow" });
  await until(() => core.of("turn.delta").length, { what: "slow reply" });
  core.post({ botling: "prepareRestart", id: 900 });
  expect(await until(() => core.responses.get(900 as unknown as string), { what: "checkpoint" })).toMatchObject({ ok: true });
  const exited = new Promise<number | null>((resolve) => core.child.once("exit", (code) => resolve(code)));
  core.post({ botling: "quit" });
  expect(await exited).toBe(0);
  expect(JSON.parse(readFileSync(join(dir, "restart-continuation.json"), "utf8")).phase).toBe("ready");
}, 30_000);

// ---- CoreClient.stop(): asks first, kills only when the core does not finish in time.
const forked: any[] = [];
vi.mock("electron", () => ({
  MessageChannelMain: class {},
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, ((...a: any[]) => void)[]>();
      const child: any = {
        pid: 4242, stdout: null, stderr: null, posted: [] as unknown[], killed: 0,
        on: (e: string, f: any) => { handlers.set(e, [...(handlers.get(e) ?? []), f]); return child; },
        once: (e: string, f: any) => child.on(e, f),
        emit: (e: string, ...a: any[]) => { for (const f of handlers.get(e) ?? []) f(...a); },
        postMessage: (m: unknown) => { child.posted.push(m); },
        // Electron: SIGTERM, then the process is cut off ~2 s later, whatever it was doing.
        kill: () => { child.killed++; setTimeout(() => child.emit("exit", 0), 2_000); return true; },
      };
      forked.push(child);
      return child;
    },
  },
}));

it("CoreClient.stop() sends the quit message and does not kill a core that is still shutting down", async () => {
  vi.useFakeTimers();
  try {
    const { CoreClient } = await import("../../src/main/core-client");
    const client = new CoreClient({ script: "/nonexistent/core/main.cjs", env: { BOTLING_QUIT_GRACE_MS: "60000" }, onEvent: () => {}, audit: () => {} });
    client.start();
    const child = forked.at(-1);
    let done = false;
    void client.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.posted).toContainEqual({ botling: "quit" });
    expect(child.killed).toBe(0);      // 10 s in: the shutdown is still allowed to run
    expect(done).toBe(false);
    child.emit("exit", 0);             // the core finished by itself
    await vi.advanceTimersByTimeAsync(10);
    expect(done).toBe(true);
    expect(child.killed).toBe(0);
  } finally { vi.useRealTimers(); }
});
