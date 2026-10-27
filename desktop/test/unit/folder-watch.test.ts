// The core's change notification (src/core/folder-watch.ts), which replaced the 1.5 s library poll and the
// 5 s memory poll: a change is noticed by the file system and handled once per burst; the slow reconcile
// still looks, re-arms a folder that went away and came back (an external disk), and a folder that cannot
// be watched is looked at on the old clock. Also the memory.md cache (MemoryFiles) both rely on.
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FolderWatch, type WatchFunction } from "../../src/core/folder-watch";
import { MemoryFiles } from "../../src/core/projects";
import { tempDir, until } from "../helpers";

const watches: FolderWatch[] = [];
afterEach(() => { for (const watch of watches.splice(0)) watch.stop(); });
const make = (options: ConstructorParameters<typeof FolderWatch>[0]) => { const watch = new FolderWatch(options); watches.push(watch); return watch; };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake fs.watch: each call is kept, its listener can be fired, and close is counted. */
function fakeWatch(fail = false) {
  const made: { path: string; recursive: boolean; fire: (name: string | null) => void; emitter: EventEmitter; closed: boolean }[] = [];
  const watch: WatchFunction = (path, options, listener) => {
    if (fail) throw new Error("ENOSYS: not supported");
    const emitter = new EventEmitter();
    const entry = { path, recursive: options.recursive, fire: (name: string | null) => listener("change", name), emitter, closed: false };
    (emitter as unknown as { close: () => void }).close = () => { entry.closed = true; };
    made.push(entry);
    return emitter as unknown as FSWatcher;
  };
  return { watch, made };
}

describe("FolderWatch", () => {
  it("notices a file written deep in a watched folder, once per burst, and not changes inside .git", async () => {
    const root = tempDir("folder-watch");
    mkdirSync(join(root, "plugin", "components", "card"), { recursive: true });
    let calls = 0;
    make({ targets: () => [{ path: root, recursive: true }], changed: () => { calls++; }, reconcileMs: 0, debounceMs: 150 }).start();
    // FSEvents may still report the folders made just before the watch began.
    await pause(400);
    calls = 0;
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "plugin", "components", "card", "template.html"), `<div>${i}</div>`);
    await until(() => calls > 0, { timeout: 5_000 });
    await pause(400);
    expect(calls).toBe(1);
    mkdirSync(join(root, ".git", "objects"), { recursive: true });
    await pause(400);
    const before = calls;
    writeFileSync(join(root, ".git", "objects", "x"), "y");
    await pause(500);
    expect(calls).toBe(before);
  });

  it("a file target hears only its own name in its folder", () => {
    const root = tempDir("folder-watch-file");
    mkdirSync(join(root, ".bot"));
    const { watch, made } = fakeWatch();
    let calls = 0;
    make({ targets: () => [{ path: join(root, ".bot", "memory.md"), file: true }], changed: () => { calls++; }, reconcileMs: 0, debounceMs: 0, watch }).start();
    expect(made.map((entry) => [entry.path, entry.recursive])).toEqual([[join(root, ".bot"), false]]);
    made[0]!.fire("chat.json");
    made[0]!.fire("memory.md");
    return until(() => calls === 1, { timeout: 1_000 });
  });

  it("does not poll between changes: nothing runs until the reconcile, which looks once", async () => {
    const root = tempDir("folder-watch-quiet");
    const { watch } = fakeWatch();
    let calls = 0;
    make({ targets: () => [{ path: root, recursive: true }], changed: () => { calls++; }, reconcileMs: 300, watch }).start();
    await pause(200);
    expect(calls).toBe(0);
    await until(() => calls === 1, { timeout: 1_000 });
  });

  it("a folder that is not there is armed once it appears (an external disk plugged in), at the reconcile", async () => {
    const root = join(tempDir("folder-watch-missing"), "Volume", "Project");
    const { watch, made } = fakeWatch();
    let calls = 0;
    const folderWatch = make({ targets: () => [{ path: root, recursive: true }], changed: () => { calls++; }, reconcileMs: 0, watch });
    folderWatch.start();
    expect(made).toHaveLength(0);
    mkdirSync(root, { recursive: true });
    folderWatch.reconcile();
    expect(made.map((entry) => entry.path)).toEqual([root]);
    expect(folderWatch.watching).toBe(1);
    expect(calls).toBe(1);
  });

  it("a folder replaced under its watcher (same path, another inode: a remounted disk) is watched again", () => {
    const root = tempDir("folder-watch-remount");
    const { watch, made } = fakeWatch();
    let inode = "1:100";
    const folderWatch = make({ targets: () => [{ path: root, recursive: true }], changed: () => {}, reconcileMs: 0, watch, identity: () => inode });
    folderWatch.start();
    folderWatch.reconcile();
    expect(made).toHaveLength(1);
    inode = "2:100";
    folderWatch.reconcile();
    expect(made).toHaveLength(2);
    expect(made[0]!.closed).toBe(true);
    expect(made[1]!.closed).toBe(false);
    // Gone (the disk unplugged): closed, and nothing armed until it is back.
    inode = null as unknown as string;
    folderWatch.reconcile();
    expect(made[1]!.closed).toBe(true);
    expect(folderWatch.watching).toBe(0);
  });

  it("a target that cannot be watched is looked at on the old clock; a watcher that errors falls back until the reconcile re-arms it", async () => {
    const root = tempDir("folder-watch-fallback");
    let calls = 0;
    const refused = fakeWatch(true);
    make({ targets: () => [{ path: root, recursive: true }], changed: () => { calls++; }, reconcileMs: 0, fallbackMs: 50, watch: refused.watch }).start();
    await until(() => calls >= 3, { timeout: 2_000 });
    watches.splice(0).forEach((watch) => watch.stop());

    calls = 0;
    const { watch, made } = fakeWatch();
    const folderWatch = make({ targets: () => [{ path: root, recursive: true }], changed: () => { calls++; }, reconcileMs: 0, fallbackMs: 50, debounceMs: 0, watch });
    folderWatch.start();
    made[0]!.emitter.emit("error", new Error("EIO"));
    expect(made[0]!.closed).toBe(true);
    await until(() => calls >= 3, { timeout: 2_000 });
    folderWatch.reconcile();
    expect(made).toHaveLength(2);
    expect(folderWatch.watching).toBe(1);
    const after = calls;
    await pause(200);
    // Watched again: the fallback clock stopped (only the reconcile's own look counted).
    expect(calls).toBe(after);
  });

  it("follows the targets: one no longer listed is closed, a new one armed", () => {
    const one = tempDir("folder-watch-a");
    const two = tempDir("folder-watch-b");
    const { watch, made } = fakeWatch();
    let targets = [{ path: one, recursive: true }];
    const folderWatch = make({ targets: () => targets, changed: () => {}, reconcileMs: 0, watch });
    folderWatch.start();
    targets = [{ path: two, recursive: true }];
    folderWatch.sync();
    expect(made.map((entry) => [entry.path, entry.closed])).toEqual([[one, true], [two, false]]);
  });
});

describe("MemoryFiles", () => {
  it("parses a memory.md once per change, and forgets one that is gone", () => {
    const folder = tempDir("memory-files");
    const file = join(folder, "memory.md");
    writeFileSync(file, "## In progress\n- Dark mode\n## Waiting on you\n- Which domain?\n");
    const memory = new MemoryFiles();
    const first = memory.items(file, "inProgress");
    expect(first).toEqual(["Dark mode"]);
    // Unchanged: the same parsed list, no read.
    expect(memory.items(file, "inProgress")).toBe(first);
    expect(memory.items(file, "waitingOnYou")).toEqual(["Which domain?"]);
    writeFileSync(file, "## In progress\n- RSS feed, and longer\n");
    expect(memory.items(file, "inProgress")).toEqual(["RSS feed, and longer"]);
    expect(memory.items(file, "waitingOnYou")).toEqual([]);
    rmSync(file);
    expect(memory.items(file, "inProgress")).toEqual([]);
    expect(memory.text(file)).toBe("");
  });
});
