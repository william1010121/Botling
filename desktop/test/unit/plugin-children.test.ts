// Phase 5c: plugins' child processes in a utility-process plugin host. The host's wrapper puts each
// child a plugin starts in a process group of its own and reports it (src/host/children.ts); main
// ends those groups with the host (src/main/plugin-children.ts). Real processes, macOS/Linux.
import { describe, expect, it } from "vitest";
import * as childProcess from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containChildren } from "../../src/host/children";
import { PluginChildren } from "../../src/main/plugin-children";
import { tempDir, until } from "../helpers";

const posix = process.platform !== "win32";

function groupExists(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function pgidOf(pid: number): number {
  return Number(childProcess.execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
}

describe.runIf(posix)("containChildren", () => {
  it("puts every child a plugin starts (spawn, exec, execFile, CommonJS and ESM imports) in a group of its own and reports it", async () => {
    const reported: number[] = [];
    containChildren((pid) => reported.push(pid));
    // A plugin's ESM import binds to the wrapped starters too (syncBuiltinESMExports).
    const esm = await import("node:child_process");
    const children = [
      esm.spawn("sleep", ["30"]),
      childProcess.spawn("sleep", ["30"], { stdio: "ignore" }),
      childProcess.exec("sleep 30", () => {}),
      childProcess.execFile("sleep", ["30"], () => {}),
    ];
    try {
      await until(() => reported.length === children.length, { what: "every child reported" });
      expect(reported.sort()).toEqual(children.map((child) => child.pid!).sort());
      // Each leads its own group (not the test's).
      for (const [index, child] of children.entries()) expect([index, pgidOf(child.pid!)]).toEqual([index, child.pid]);
      expect(pgidOf(children[0]!.pid!)).not.toBe(pgidOf(process.pid));
      // The plugin's own options still apply; the synchronous starters run as before (not reported).
      expect(childProcess.execFileSync("/bin/sh", ["-c", "echo $PWD"], { cwd: "/", encoding: "utf8" })).toBe("/\n");
      expect(childProcess.spawnSync("true").status).toBe(0);
      expect(reported).toHaveLength(children.length);
    } finally {
      for (const child of children) try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });
});

describe.runIf(posix)("PluginChildren", () => {
  /** A child in a group of its own that starts a grandchild in the same group (the case a plain kill misses). */
  function plugin(): { leader: number; grandchild: () => number } {
    const dir = tempDir("plugin-children");
    const file = join(dir, "grandchild");
    const child = childProcess.spawn("/bin/sh", ["-c", `sleep 300 & echo $! > '${file}'; wait`], { detached: true, stdio: "ignore" });
    child.unref();
    return { leader: child.pid!, grandchild: () => Number(readFileSync(file, "utf8").trim()) };
  }

  it("ends a host's groups (SIGTERM, then SIGKILL), grandchildren included, and keeps them in the ledger meanwhile", async () => {
    const dir = tempDir("plugin-children-ledger");
    const ledgerFile = join(dir, "children.json");
    const children = new PluginChildren({ ledgerFile });
    const a = plugin();
    const b = plugin();
    await until(() => { try { return a.grandchild() > 0 && b.grandchild() > 0; } catch { return false; } }, { what: "the grandchildren" });
    children.add(7, a.leader);
    children.add(7, b.leader);
    children.add(8, b.leader); // another host's list
    expect(children.of(7)).toEqual([a.leader, b.leader]);
    await until(() => existsSync(ledgerFile) && (JSON.parse(readFileSync(ledgerFile, "utf8")) as { pgid: number }[]).length >= 2, { what: "the ledger" });
    const ledger = JSON.parse(readFileSync(ledgerFile, "utf8")) as { pgid: number; core: number }[];
    expect(ledger.map((entry) => entry.pgid)).toEqual(expect.arrayContaining([a.leader, b.leader]));
    expect(ledger.every((entry) => entry.core === process.pid)).toBe(true);
    const grandchildren = [a.grandchild(), b.grandchild()];
    await children.end(7, 1_000);
    for (const pgid of [a.leader, b.leader]) expect(groupExists(pgid)).toBe(false);
    for (const pid of grandchildren) expect(alive(pid)).toBe(false);
    expect(children.of(7)).toEqual([]);
    expect((JSON.parse(readFileSync(ledgerFile, "utf8")) as { pgid: number }[]).filter((entry) => [a.leader, b.leader].includes(entry.pgid))).toEqual([]);
    // Host 8's entry was the same group, already gone: nothing to do.
    await children.end(8);
  });

  it("SIGKILLs a group that ignores SIGTERM after the grace", async () => {
    const children = new PluginChildren();
    const ready = join(tempDir("plugin-children-stubborn"), "ready");
    const stubborn = childProcess.spawn("/bin/sh", ["-c", `trap '' TERM; touch '${ready}'; sleep 300 & wait; sleep 300`], { detached: true, stdio: "ignore" });
    stubborn.unref();
    await until(() => existsSync(ready), { what: "the stubborn child" });
    children.add(1, stubborn.pid);
    const started = Date.now();
    await children.end(1, 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    // (The leader is this test's own child: gone once Node has reaped it.)
    await until(() => !groupExists(stubborn.pid!), { what: "the group gone" });
  });

  it("refuses what is not a plugin's group: main itself, protected pids, nonsense, dead pids", () => {
    const children = new PluginChildren({ protectedPids: () => [process.ppid] });
    for (const pid of [process.pid, process.ppid, 0, 1, -5, 1.5, "12", null, 999_999_999]) children.add(3, pid);
    expect(children.of(3)).toEqual([]);
  });

  it("endAll waits for a host already being ended", async () => {
    const children = new PluginChildren();
    const ready = join(tempDir("plugin-children-wait"), "ready");
    const stubborn = childProcess.spawn("/bin/sh", ["-c", `trap '' TERM; touch '${ready}'; sleep 300 & wait; sleep 300`], { detached: true, stdio: "ignore" });
    stubborn.unref();
    await until(() => existsSync(ready), { what: "the child" });
    children.add(2, stubborn.pid);
    void children.end(2, 400);
    await children.endAll();
    await until(() => !groupExists(stubborn.pid!), { what: "the group gone" });
  });
});
