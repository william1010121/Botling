// `sessions.folder` (spec/models/folders) against the core's real Plugins and SessionFolders, through
// spec-adapters/folders-adapter.ts. Conformance: seeded random walks of the reference, and a few fixed ones, are
// driven into the app; after every step what the core shows (the plugin's state, the lines on their way, the cache,
// the file, what sessionFolder answers, how often the session was told it moved) must be what the reference says,
// and the reference keeps the model's invariants and step properties. The bot's side (restart once before the next
// message, held while its own work runs) is bot.ts's: the walks check it in the reference, and
// desktop/test/unit/folder-move-restart.test.ts checks the real Bot.
// SPEC_BUG=folders runs the reference as bot.ts was before the model ("nohold"): the walks must go red.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFoldersDriver } from "../../desktop/spec-adapters/folders-adapter";
import type { FoldersDriver } from "../driver/folders-driver";
import { FoldersReference, P, viewOf, type FoldersAction, type FoldersState } from "../reference/folders";

const BUG = process.env.SPEC_BUG === "folders" ? "nohold" as const : undefined;

const dirs: string[] = [];
const drivers: FoldersDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(): Promise<{ driver: FoldersDriver; ref: FoldersReference }> {
  const dataDir = mkdtempSync(join(tmpdir(), "spec-folders-"));
  dirs.push(dataDir);
  const driver = await createFoldersDriver({ dataDir });
  drivers.push(driver);
  return { driver, ref: new FoldersReference({ folders: ["w1", "w2"], maxUses: 4, maxBoots: 2, maxEnables: 2, bug: BUG }) };
}

/** The core's side is driven; the bot's (Msg … Sleep) lives in the reference only. */
async function drive(driver: FoldersDriver, a: FoldersAction) {
  switch (a.name) {
    case "Use": return driver.use(a.f);
    case "Load": return driver.load();
    case "Crash": return driver.crash(a.keep);
    case "HostRestart": return driver.hostRestart();
    case "Disable": return driver.disable();
    case "Enable": return driver.enable();
    case "CoreRecv": return driver.coreRecv(a.dup, a.saved);
    case "AppRestart": return driver.appRestart();
    default: return;
  }
}

const label = (a: FoldersAction) => a.name + ("f" in a ? `(${a.f})` : "keep" in a ? `(${a.keep})` : "dup" in a ? `(${a.dup ? "dup" : ""}${a.saved ? "" : " unsaved"})` : "");

async function walk(pick: (enabled: FoldersAction[], step: number) => FoldersAction | null, steps: number) {
  const { driver, ref } = await open();
  let s = ref.init();
  const done: string[] = [];
  expect(driver.view()).toEqual(viewOf(ref, s));
  for (let step = 0; step < steps; step++) {
    const a = pick(ref.enabled(s), step);
    if (!a) break;
    const next = ref.step(s, a);
    if (!next) throw new Error(`${label(a)} is not enabled after ${done.join(" ")}`);
    await drive(driver, a);
    done.push(label(a));
    expect(ref.stepProperties(s, next), done.join(" ")).toEqual([]);
    s = next;
    expect(ref.invariants(s), done.join(" ")).toEqual([]);
    expect(driver.view(), done.join(" ")).toEqual(viewOf(ref, s));
  }
  return { s, done, driver, ref };
}

/** A seeded generator (mulberry32). */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randomly = (seed: number) => {
  const next = random(seed);
  const any = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  return (enabled: FoldersAction[]) => {
    if (!enabled.length) return null;
    const name = any([...new Set(enabled.map((a) => a.name))]);
    return any(enabled.filter((a) => a.name === name));
  };
};
const fixed = (actions: FoldersAction[]) => (_: FoldersAction[], step: number) => actions[step] ?? null;
const recv: FoldersAction = { name: "CoreRecv", dup: false, saved: true };

describe("sessions.folder conformance", () => {
  it.each([
    ["a folder the plugin sets is answered at once; the awake bot restarts there once", [
      { name: "Load" }, recv, { name: "Msg" }, { name: "EndTurn" }, { name: "Use", f: "w1" }, recv, { name: "Msg" }, { name: "EndTurn" }, { name: "Msg" },
    ]],
    ["after a restart of Botling the first turn is already in the worktree, before the plugin loads", [
      { name: "Load" }, recv, { name: "Use", f: "w1" }, recv, { name: "AppRestart" }, { name: "Msg" }, { name: "Load" }, recv,
    ]],
    ["a line lost with the host is made good by the picture the plugin loads with", [
      { name: "Load" }, recv, { name: "Use", f: "w1" }, { name: "Crash", keep: 0 }, { name: "HostRestart" }, { name: "Load" }, recv,
    ]],
    ["the third crash fails the plugin: its bots are back in the project folder, and lines from it are refused", [
      { name: "Load" }, recv, { name: "Use", f: "w1" }, recv, { name: "Crash", keep: 0 }, { name: "HostRestart" }, { name: "Load" },
      { name: "Crash", keep: 1 }, { name: "HostRestart" }, { name: "Crash", keep: 1 }, recv, { name: "Msg" },
    ]],
    ["turned off it decides nothing; on again its folder comes back from the cache", [
      { name: "Load" }, recv, { name: "Use", f: "w2" }, recv, { name: "Msg" }, { name: "Disable" }, { name: "EndTurn" }, { name: "Msg" }, { name: "EndTurn" },
      { name: "Enable" }, { name: "Msg" },
    ]],
    ["a failed write leaves the file as it was; after a restart the plugin's picture puts it right", [
      { name: "Load" }, recv, { name: "Use", f: "w1" }, recv, { name: "Use", f: "w2" }, { name: "CoreRecv", dup: true, saved: false }, recv,
      { name: "AppRestart" }, { name: "Load" }, recv,
    ]],
    ["a move while its own work runs: your message waits, then goes after one restart", [
      { name: "Load" }, recv, { name: "Msg" }, { name: "StartWork" }, { name: "EndTurn" }, { name: "Use", f: "w1" }, recv, { name: "Msg" },
      { name: "EndWork" }, { name: "Release" },
    ]],
  ] as [string, FoldersAction[]][])("%s", async (_, actions) => {
    const { done } = await walk(fixed(actions), actions.length);
    expect(done).toHaveLength(actions.length);
  });

  it.each(Array.from({ length: 24 }, (_, i) => 5000 + i))("random walk %i, then settled: the cache is the plugin's truth", async (seed) => {
    const { driver, ref, s: walked } = await walk(randomly(seed), 60);
    let s = walked;
    // Fairness: the host comes back, the plugin loads, the pipe delivers.
    for (let rounds = 0; rounds < 100; rounds++) {
      const a = ref.enabled(s).find((candidate) => candidate.name === "HostRestart" || candidate.name === "Load" || (candidate.name === "CoreRecv" && !candidate.dup && candidate.saved));
      if (!a) break;
      await drive(driver, a);
      s = ref.step(s, a)!;
      expect(driver.view()).toEqual(viewOf(ref, s));
    }
    if (s.pstate === "running") expect(s.cache, `seed ${seed}`).toBe(s.truth);
    else expect(["failed", "disabled"]).toContain(s.pstate);
    if (s.pstate !== "running") expect(driver.view().resolved).toBe(P);
  });
});
