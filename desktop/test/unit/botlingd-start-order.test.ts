// M7-S84 golden: the order in which `Botlingd.start` opens things (log lines, timers, listeners, files in the data folder)
// and `Botlingd.stop` closes them. Recorded on the base commit, before `start` was cut into phase methods; the cut keeps
// the statements in the same order, so this list must not change with it.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Botlingd } from "../../src/server/botlingd";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop } from "../helpers";

/** What start did, in order: `log <tag>`, `interval <ms>`, `timeout <ms>`, `listen <kind>`, `files +a +b` (new in the data folder). */
const EXPECTED_START: string[] = [
  "files +core.lock +server-keys.json +server.db",
  "log identity",
  "files +agents.json +component-editor.json +main +plugins",
  "interval 60000",
  "interval 15000",
  "interval 20000",
  "interval 60000",
  "files +uploads",
  "log recovery",
  "log summary rows",
  "timeout 3600000",
  "files +children.json +plugin-data",
  "log core",
  "interval 60000",
  "log content recovery",
  "files +variants",
  "log media jobs",
  "log media note",
  "log media note",
  "files +peer-chunks",
  "interval 1000",
  "files +botlingd.token",
  "listen path",
  "files +botlingd.sock",
  "listen port",
  "log listener",
  "files +botlingd.listen.json",
  "interval 5000",
  "interval 3000",
  "timeout 300000",
  "log note ",
  "log note ",
  "log note ",
  "log started",
];
/** What stop did, in order. */
const EXPECTED_STOP: string[] = [
  "clear interval 3000",
  "clear interval 60000",
  "files -botlingd.sock",
  "clear interval 5000",
  "clear interval 1000",
  "files -botlingd.listen.json",
  "clear interval 15000",
  "clear interval 20000",
  "clear interval 60000",
  "clear interval 60000",
  "log core",
  "files -core.lock",
  "log stopped",
];

const FROM_SERVER_CODE = /\/src\/(server|core)\//;
/** Short timeouts come from async work (retries, debounces) that moves between runs; the long ones are the schedules start sets. */
const LONG_TIMEOUT_MS = 60_000;
const SIDE_FILES = /-(wal|shm|journal)$|^botlingd\.log$/;

describe("M7-S84: Botlingd start / stop order", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length) await cleanups.pop()!();
  });

  /** One start and stop on a fresh data folder, with the order of what happened. */
  async function record(tag: string): Promise<{ start: string[]; stop: string[] }> {
    const root = testRoot(`start-order-${tag}`);
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });

    let events: string[] = [];
    let seen = new Set<string>();
    const names = (): Set<string> => new Set(readdirSync(dataDir).filter((name) => !SIDE_FILES.test(name)));
    /** Notes the files that appeared or went away since the last event, then the event. */
    const mark = (event: string | null): void => {
      const now = names();
      const added = [...now].filter((name) => !seen.has(name)).sort();
      const removed = [...seen].filter((name) => !now.has(name)).sort();
      if (added.length) events.push(`files ${added.map((name) => `+${name}`).join(" ")}`);
      if (removed.length) events.push(`files ${removed.map((name) => `-${name}`).join(" ")}`);
      seen = now;
      if (event !== null) events.push(event);
    };

    const handles = new Map<unknown, number>();
    const realInterval = globalThis.setInterval;
    const realTimeout = globalThis.setTimeout;
    const realClear = globalThis.clearInterval;
    const mine = (): boolean => FROM_SERVER_CODE.test(new Error().stack ?? "");
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realInterval(fn, ms, ...rest);
      if (mine()) { handles.set(handle, ms ?? 0); mark(`interval ${ms}`); }
      return handle;
    }) as unknown as typeof setInterval);
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      if ((ms ?? 0) >= LONG_TIMEOUT_MS && mine()) mark(`timeout ${ms}`);
      return realTimeout(fn, ms, ...rest);
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((handle: unknown) => {
      if (handles.has(handle)) { mark(`clear interval ${handles.get(handle)}`); handles.delete(handle); }
      return realClear(handle as never);
    }) as unknown as typeof clearInterval);
    const realListen = net.Server.prototype.listen;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (this: net.Server, ...args: unknown[]) {
      const first = args[0] as unknown;
      const kind = typeof first === "string" ? "path" : typeof first === "number" ? "port" : (first as { path?: string } | null)?.path ? "path" : "port";
      mark(`listen ${kind}`);
      return (realListen as (...a: unknown[]) => net.Server).apply(this, args);
    } as unknown as typeof net.Server.prototype.listen);

    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir),
      outDir: join(desktop, "out"),
      log: (line) => mark(`log ${line.split(/[:,(]/)[0]}`),
    });
    mark(null);
    const start = events;
    events = [];
    await daemon.stop();
    mark(null);
    const stop = events;
    vi.restoreAllMocks();
    return { start, stop };
  }

  it("starts and stops in the same order every time", async () => {
    const runs = [await record("a"), await record("b"), await record("c")];
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].start).toEqual(EXPECTED_START);
    expect(runs[0].stop).toEqual(EXPECTED_STOP);
  }, 120_000);
});
