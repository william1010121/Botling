// The workspace change watch (spec/models/workspace) against the real plugin host and core Plugins,
// through spec-adapters/workspace-adapter.ts. Conformance: seeded random walks of the reference, and a
// few fixed ones, are driven into the app; after every step what the app shows (each plugin's listener,
// what it last read, the lines on their way, the core's watch and stamp) must be what the reference says.
// SPEC_BUG=workspace runs the reference as the first draft of W1 was (the host said someone listens
// after the first read): it must go red.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceDriver } from "../../desktop/spec-adapters/workspace-adapter";
import type { WorkspaceDriver } from "../driver/workspace-driver";
import { WorkspaceReference, viewOf, type WorkspaceAction, type WorkspaceState } from "../reference/workspace";

const BUG = process.env.SPEC_BUG === "workspace";
const PLUGINS = ["p1", "p2"];

const dirs: string[] = [];
const drivers: WorkspaceDriver[] = [];
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(maxVer = 3, maxListens = 2): Promise<{ driver: WorkspaceDriver; ref: WorkspaceReference }> {
  const dataDir = mkdtempSync(join(tmpdir(), "spec-workspace-"));
  dirs.push(dataDir);
  const driver = await createWorkspaceDriver({ dataDir, plugins: PLUGINS });
  drivers.push(driver);
  return { driver, ref: new WorkspaceReference({ plugins: PLUGINS, maxVer, maxListens, bug: BUG }) };
}

async function drive(driver: WorkspaceDriver, a: WorkspaceAction) {
  switch (a.name) {
    case "Change": return driver.change();
    case "Listen": return driver.listen(a.p);
    case "Unlisten": return driver.unlisten(a.p);
    case "Read": return driver.read(a.p);
    case "HostRecv": return driver.hostRecv();
    case "CoreRecv": return driver.coreRecv();
    case "Check": return driver.check();
  }
}

const label = (a: WorkspaceAction) => ("p" in a ? `${a.name}(${a.p})` : a.name);

/** Drives the actions `pick` chooses and compares app and reference after every step. */
async function walk(pick: (enabled: WorkspaceAction[], step: number, s: WorkspaceState) => WorkspaceAction | null, steps: number) {
  const { driver, ref } = await open();
  let s = ref.init();
  const done: string[] = [];
  expect(driver.view()).toEqual(viewOf(s));
  for (let step = 0; step < steps; step++) {
    const a = pick(ref.enabled(s), step, s);
    if (!a) break;
    const next = ref.step(s, a);
    if (!next) throw new Error(`${label(a)} is not enabled after ${done.join(" ")}`);
    await drive(driver, a);
    s = next;
    done.push(label(a));
    expect(ref.invariants(s), done.join(" ")).toEqual([]);
    expect(driver.view(), done.join(" ")).toEqual(viewOf(s));
  }
  return { s, done };
}

/** A seeded generator (mulberry32). */
function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randomly = (seed: number) => {
  const next = random(seed);
  const any = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  return (enabled: WorkspaceAction[]) => {
    if (!enabled.length) return null;
    const name = any([...new Set(enabled.map((a) => a.name))]);
    return any(enabled.filter((a) => a.name === name));
  };
};
const fixed = (actions: WorkspaceAction[]) => (_: WorkspaceAction[], step: number) => actions[step] ?? null;

/** Delivers and looks until nothing is left (what fairness promises), then says whether every listener knows what is there. */
async function settle(driver: WorkspaceDriver, ref: WorkspaceReference, s: WorkspaceState) {
  for (let rounds = 0; rounds < 100; rounds++) {
    const a = ref.enabled(s).find((candidate) => ["CoreRecv", "HostRecv", "Check", "Read"].includes(candidate.name));
    if (!a) break;
    await drive(driver, a);
    s = ref.step(s, a)!;
    expect(driver.view()).toEqual(viewOf(s));
  }
  return s;
}

describe("workspace watch conformance", () => {
  it.each([
    ["a change after listening is told, and the listener reads it", [
      { name: "Listen", p: "p1" }, { name: "CoreRecv" }, { name: "Change" }, { name: "CoreRecv" }, { name: "HostRecv" },
      { name: "Check" }, { name: "HostRecv" }, { name: "Read", p: "p1" }, { name: "CoreRecv" }, { name: "HostRecv" },
    ]],
    ["a change between listening and the first read is in that read: the host said it listens first, so nothing is left to tell", [
      { name: "Listen", p: "p1" }, { name: "Change" }, { name: "CoreRecv" }, { name: "CoreRecv" }, { name: "HostRecv" },
    ]],
    ["a second listener keeps the watch's digest; nobody listening stops it", [
      { name: "Listen", p: "p1" }, { name: "CoreRecv" }, { name: "CoreRecv" }, { name: "HostRecv" }, { name: "Change" },
      { name: "Listen", p: "p2" }, { name: "CoreRecv" }, { name: "Check" }, { name: "CoreRecv" }, { name: "HostRecv" }, { name: "HostRecv" },
      { name: "Unlisten", p: "p1" }, { name: "Unlisten", p: "p2" }, { name: "CoreRecv" }, { name: "CoreRecv" },
    ]],
    ["nothing is told while nobody listens", [{ name: "Change" }, { name: "Listen", p: "p1" }, { name: "Unlisten", p: "p1" }, { name: "CoreRecv" }, { name: "CoreRecv" }, { name: "CoreRecv" }, { name: "Change" }]],
  ] as [string, WorkspaceAction[]][])("%s", async (_, actions) => {
    const { done } = await walk(fixed(actions), actions.length);
    expect(done).toHaveLength(actions.length);
  });

  it.each(Array.from({ length: 16 }, (_, i) => 3000 + i))("random walk %i, then settled: every listener knows what is there", async (seed) => {
    const { driver, ref } = await open();
    let s = ref.init();
    const pick = randomly(seed);
    for (let step = 0; step < 40; step++) {
      const a = pick(ref.enabled(s));
      if (!a) break;
      await drive(driver, a);
      s = ref.step(s, a)!;
      expect(driver.view(), `seed ${seed} step ${step} ${label(a)}`).toEqual(viewOf(s));
    }
    s = await settle(driver, ref, s);
    for (const p of PLUGINS) if (s.sub[p]) expect(s.known[p], `seed ${seed}: ${p}`).toBe(s.ver);
  });
});
