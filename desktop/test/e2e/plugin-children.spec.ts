// Phase 5c: what a plugin's program part starts ends with its plugin host — the utility process main
// runs — whether the host crashes, is stopped (the plugin turned off) or the app quits. Each child
// leads a process group of its own (src/host/children.ts) that main ends (src/main/plugin-children.ts),
// grandchildren included.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive, pidsIn, tempDir, until } from "../helpers";
import { launch, post } from "./launch";

/** A plugin whose program part starts, on each activation, a spawn()ed and an exec()ed shell, each with a grandchild. */
function writePlugin(core: string, pids: string) {
  const folder = join(core, "plugins", "spawner");
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({
    name: "spawner", displayName: "Spawner", version: "1.0.0", description: "Starts processes.", engines: { ccb: "^2.0.0" },
    ccb: { host: "dist/host.mjs", contributes: { commands: [{ id: "spawner.ping", title: "Ping" }] } },
  }));
  // Each shell writes its own pid and its background sleep's pid to the file, then waits.
  const script = `echo $$ >> '${pids}'; sleep 600 & echo $! >> '${pids}'; wait`;
  writeFileSync(join(folder, "dist", "host.mjs"), `import { spawn, exec } from "node:child_process";
export function activate(ccb) {
  spawn("/bin/sh", ["-c", ${JSON.stringify(script)}], { stdio: "ignore" });
  exec(${JSON.stringify(script)}, () => {});
  ccb.commands.register("spawner.ping", () => "pong");
}
`);
}

test("a plugin's child processes end with its host: crashed, turned off, the app quit", async () => {
  test.skip(process.platform === "win32", "Process groups: macOS and Linux (Windows: taskkill, unverified).");
  const dataDir = tempDir("e2e-plugin-children");
  const pids = join(tempDir("e2e-plugin-children-pids"), "pids");
  writePlugin(join(dataDir, "core"), pids);
  const { app, page } = await launch({ dataDir, env: { BOTLING_MOCK_KEYCHAIN: "1" } });
  let all: number[] = [];
  const started = async (count: number) => {
    await until(() => pidsIn(pids).length >= count, { timeout: 20_000, what: `${count} pids written` });
    const now = pidsIn(pids);
    all = now;
    return now;
  };
  let n = 0;
  const send = (cmd: Record<string, unknown>) => post(page, { v: 10, id: `children-${++n}`, cmd });
  try {
    // The host started on its own (the plugin has a program part); its plugin started two shells.
    const first = await started(4);
    expect(first.every(alive)).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingPluginGroups().length), { timeout: 10_000 }).toBe(2);
    const [host] = await app.evaluate(() => (globalThis as any).__botlingHostPids()) as number[];
    expect(host).toBeGreaterThan(0);

    // 1. The host crashes: what it started goes with it, and the restarted host's plugin starts anew.
    process.kill(host!, "SIGKILL");
    await expect.poll(() => first.filter(alive), { timeout: 10_000 }).toEqual([]);
    const second = (await started(8)).slice(4);
    expect(second.every(alive)).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingPluginGroups().length), { timeout: 10_000 }).toBe(2);

    // 2. The plugin turned off: its host shuts down, and its processes end.
    expect((await send({ type: "plugins.enable", name: "spawner", enabled: false })).ok).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingHostPids().length), { timeout: 10_000 }).toBe(0);
    await expect.poll(() => second.filter(alive), { timeout: 10_000 }).toEqual([]);

    // 3. On again, then the app quits: nothing it started is left.
    expect((await send({ type: "plugins.enable", name: "spawner", enabled: true })).ok).toBe(true);
    const third = (await started(12)).slice(8);
    expect(third.every(alive)).toBe(true);
    await expect.poll(() => app.evaluate(() => (globalThis as any).__botlingPluginGroups().length), { timeout: 10_000 }).toBe(2);
    await app.close();
    await expect.poll(() => third.filter(alive), { timeout: 10_000 }).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    for (const pid of all) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
