// One core per data folder. Two cores on the same folder each keep the chats in memory and rewrite
// chat.json whole, so the one with the older copy wipes out what the other wrote (2.3.3 trial: a
// Botling started on Oct 31 kept running beside every newer build for two days, and the botling
// bot's chat lost Nov 1-2). The Chromium single-instance lock did not stop it: the data folder was
// renamed and replaced under a running app, and the lock files went with the old folder.
import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CoreHarness, MAIN } from "../core-harness";
import { tempDir, until } from "../helpers";
import { CORE_EXIT_DATA_DIR_IN_USE, DataDirLock, LOCK_DIR, processStartTime, readLockHolder } from "../../src/core/store/data-dir-lock";

const running: CoreHarness[] = [];
afterEach(async () => { for (const core of running.splice(0)) await core.kill(); });

const start = (dir: string, env: Record<string, string> = {}) => {
  const core = new CoreHarness(dir, { BOTLING_DATA_LOCK_CHECK_MS: "100", ...env });
  running.push(core);
  return core;
};
const exitCode = (core: CoreHarness) => until(() => (core.child.exitCode !== null || core.child.signalCode !== null ? { code: core.child.exitCode } : null), { timeout: 15_000, what: "the core to exit" });

describe("a second core on the same data folder", () => {
  it("refuses to start and does not touch the chat files", async () => {
    const dir = tempDir("data-lock");
    const first = start(dir, { BOTLING_APP_VERSION: "2.2.0-local.1", BOTLING_APP_PATH: "/Applications/Botling 2 Dev Trial.app" });
    await first.chat(MAIN);
    const chat = join(dir, "main", "chat.json");
    const before = existsSync(chat) ? { text: readFileSync(chat, "utf8"), mtime: statSync(chat).mtimeMs } : null;

    const second = start(dir, { BOTLING_DATA_LOCK_WAIT_MS: "500" });
    expect((await exitCode(second)).code).toBe(CORE_EXIT_DATA_DIR_IN_USE);
    expect(second.stderr).toMatch(/version 2\.2\.0-local\.1, from \/Applications\/Botling 2 Dev Trial\.app\) already uses this data folder/);
    const after = existsSync(chat) ? { text: readFileSync(chat, "utf8"), mtime: statSync(chat).mtimeMs } : null;
    expect(after).toEqual(before);
    // The first one is unharmed.
    expect(first.child.exitCode).toBeNull();
    await first.chat(MAIN);
  }, 40_000);

  it("a core whose folder was swapped out under it stops, so only the new owner writes", async () => {
    const dir = tempDir("data-lock-swap");
    const old = start(dir);
    await old.chat(MAIN);
    // What a rollback/data migration does: the live folder is renamed aside and a copy is put in its
    // place. The running core still writes by path, i.e. into the copy. The copy even carries the old
    // core's lock file: the new core waits for the old one to let go. (The old core checks every 100 ms
    // here, so it may already have seen the swap and removed its record from the copy before the new one
    // starts; either way the old one stops and the new one owns the folder.)
    renameSync(dir, `${dir}.moved`);
    cpSync(`${dir}.moved`, dir, { recursive: true });
    const fresh = start(dir);
    await fresh.chat(MAIN);
    expect((await exitCode(old)).code).toBe(CORE_EXIT_DATA_DIR_IN_USE);
    expect(fresh.child.exitCode).toBeNull();
    await fresh.chat(MAIN);
  }, 40_000);

  it("a core that crashed leaves a lock the next core takes over", async () => {
    const dir = tempDir("data-lock-crash");
    const crashed = start(dir);
    await crashed.chat(MAIN);
    await crashed.kill("SIGKILL");
    expect(readLockHolder(dir)?.pid).toBe(crashed.child.pid);
    const next = start(dir, { BOTLING_APP_VERSION: "9.9.9", BOTLING_APP_PATH: "/Applications/Botling 2.app" });
    await next.chat(MAIN);
    expect(readLockHolder(dir)).toMatchObject({ pid: next.child.pid, version: "9.9.9", app: "/Applications/Botling 2.app" });
  }, 40_000);

  it("a lock left by a core that is gone is taken over, even a lock file from 7be956c7's builds", async () => {
    const dir = tempDir("data-lock-stale");
    writeFileSync(join(dir, LOCK_DIR), JSON.stringify({ pid: 2 ** 22 + 12345, boot: "gone", at: Date.now(), machineBoot: Date.now() }));
    const core = start(dir);
    await core.chat(MAIN);
    expect(readLockHolder(dir)?.pid).toBe(core.child.pid);
    await core.kill();
    // A clean exit gives the folder back.
    expect(existsSync(join(dir, LOCK_DIR))).toBe(false);
  }, 40_000);
});

describe("DataDirLock", () => {
  const alive = new Set<number>([111, 222]);
  /** When each "running" pid's process started (none: the system cannot say). */
  const startedAt = new Map<number, number>();
  const lockIn = (dir: string, pid: number, boot: string, machineBoot = 1_000_000) =>
    new DataDirLock(dir, { pid, boot, alive: (p) => alive.has(p), startTime: (p) => startedAt.get(p) ?? null, machineBoot: () => machineBoot });
  afterEach(() => startedAt.clear());

  it("only one holder at a time; the holder may claim again", () => {
    const dir = tempDir("lock-unit");
    const a = lockIn(dir, 111, "a");
    expect(a.claim()).toEqual({ ok: true });
    expect(a.claim()).toEqual({ ok: true });
    const b = lockIn(dir, 222, "b");
    const refused = b.claim();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.holder.pid).toBe(111);
    expect(a.owns()).toBe(true);
    expect(b.owns()).toBe(false);
  });

  it("a holder that is not running, or ran before this machine started, is stale", () => {
    const dir = tempDir("lock-unit-stale");
    writeFileSync(join(dir, LOCK_DIR), JSON.stringify({ pid: 999, boot: "x", at: 1, machineBoot: 1_000_000 }));
    expect(lockIn(dir, 111, "a").claim()).toEqual({ ok: true });
    // pid 111 is "alive" again after a restart of the machine, but it is some other process now.
    expect(lockIn(dir, 222, "b", 2_000_000).claim()).toEqual({ ok: true });
  });

  it("owns() is false once another core holds the file at this path, and release keeps others' locks", () => {
    const dir = tempDir("lock-unit-owner");
    const a = lockIn(dir, 111, "a");
    a.claim();
    rmSync(join(dir, LOCK_DIR), { recursive: true });
    const b = lockIn(dir, 222, "b");
    expect(b.claim()).toEqual({ ok: true });
    expect(a.owns()).toBe(false);
    a.release();
    expect(existsSync(join(dir, LOCK_DIR))).toBe(true);
    b.release();
    expect(existsSync(join(dir, LOCK_DIR))).toBe(false);
  });

  it("a folder put in place of the claimed one is not owned, even with no lock file in it", () => {
    const dir = tempDir("lock-unit-swapped");
    const a = lockIn(dir, 111, "a");
    a.claim();
    renameSync(dir, `${dir}.moved`);
    cpSync(`${dir}.moved`, dir, { recursive: true });
    rmSync(join(dir, LOCK_DIR), { recursive: true });
    expect(a.owns()).toBe(false);
    expect(existsSync(join(dir, LOCK_DIR))).toBe(false);
  });

  it("a missing lock file is claimed back by its last holder", () => {
    const dir = tempDir("lock-unit-missing");
    const a = lockIn(dir, 111, "a");
    a.claim();
    rmSync(join(dir, LOCK_DIR), { recursive: true });
    expect(a.owns()).toBe(true);
    expect(existsSync(join(dir, LOCK_DIR))).toBe(true);
  });

  it("a pid now used by a process that started after the lock was written is stale (pid reuse)", () => {
    const dir = tempDir("lock-unit-reuse");
    const a = lockIn(dir, 111, "a");
    a.claim();
    const { at } = readLockHolder(dir)!;
    // pid 111 is still running and started before the lock was written: it is the holder.
    startedAt.set(111, at - 60_000);
    expect(lockIn(dir, 222, "b").claim().ok).toBe(false);
    // A clock that moved a little since is not mistaken for another process.
    startedAt.set(111, at + 5_000);
    expect(lockIn(dir, 222, "b").claim().ok).toBe(false);
    // The holder died and pid 111 went to a process started later: the lock is stale.
    startedAt.set(111, at + 3_600_000);
    expect(lockIn(dir, 222, "b").claim()).toEqual({ ok: true });
    expect(readLockHolder(dir)?.pid).toBe(222);
  });

  it("renaming the folder, or reaching it through a symlink, does not let a second core in", () => {
    const dir = tempDir("lock-unit-rename");
    const a = lockIn(dir, 111, "a");
    expect(a.claim()).toEqual({ ok: true });
    renameSync(dir, `${dir}.renamed`);
    const refused = lockIn(`${dir}.renamed`, 222, "b").claim();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.holder.pid).toBe(111);
    symlinkSync(`${dir}.renamed`, `${dir}.link`);
    expect(lockIn(`${dir}.link`, 222, "b").claim().ok).toBe(false);
    // The core that claimed it no longer owns the path it opened (something else may be put there).
    expect(a.owns()).toBe(false);
  });

  it("a lock file from 7be956c7's builds whose holder runs is respected", () => {
    const dir = tempDir("lock-unit-legacy");
    writeFileSync(join(dir, LOCK_DIR), JSON.stringify({ pid: 111, boot: "old", at: 1, machineBoot: 1_000_000 }));
    const refused = lockIn(dir, 222, "b").claim();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.holder).toMatchObject({ pid: 111, boot: "old" });
    alive.delete(111);
    try {
      expect(lockIn(dir, 222, "b").claim()).toEqual({ ok: true });
      expect(readLockHolder(dir)?.boot).toBe("b");
    } finally {
      alive.add(111);
    }
  });

  it("something else left in an empty lock (Finder's .DS_Store) does not keep the folder locked", () => {
    const dir = tempDir("lock-unit-stray");
    const a = lockIn(dir, 111, "a");
    a.claim();
    a.release();
    mkdirSync(join(dir, LOCK_DIR));
    writeFileSync(join(dir, LOCK_DIR, ".DS_Store"), "");
    expect(lockIn(dir, 222, "b").claim()).toEqual({ ok: true });
    expect(readLockHolder(dir)?.boot).toBe("b");
  });

  it("release gives the folder back to the next core", () => {
    const dir = tempDir("lock-unit-release");
    const a = lockIn(dir, 111, "a");
    a.claim();
    expect(lockIn(dir, 222, "b").claim().ok).toBe(false);
    a.release();
    expect(existsSync(join(dir, LOCK_DIR))).toBe(false);
    expect(lockIn(dir, 222, "b").claim()).toEqual({ ok: true });
  });

  it("the record names the holder's version and app, and leaves no temp files", () => {
    const dir = tempDir("lock-unit-record");
    new DataDirLock(dir, { pid: 111, boot: "a", version: "2.3.3", app: "/Applications/Botling 2.app" }).claim();
    expect(readLockHolder(dir)).toMatchObject({ pid: 111, boot: "a", version: "2.3.3", app: "/Applications/Botling 2.app" });
    expect(readdirSync(dir)).toEqual([LOCK_DIR]);
    expect(readdirSync(join(dir, LOCK_DIR))).toEqual([expect.stringMatching(/^111\.[0-9a-f]{8}\.json$/)]);
  });

  it("knows when this process started", () => {
    const started = processStartTime(process.pid);
    if (process.platform === "win32") return expect(started).toBeNull();
    expect(started).not.toBeNull();
    expect(Math.abs(started! - (Date.now() - process.uptime() * 1000))).toBeLessThan(5_000);
  });
});
