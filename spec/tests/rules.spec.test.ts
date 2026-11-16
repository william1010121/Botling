// The orchestration rules a plugin gives, and core's own when it cannot, against spec/models/rules: seeded random walks
// drive the real OrchestrationRulesBook and chosenSource through the adapter, compared with spec/reference/rules.ts after
// every step; the reference, explored like TLC, has the model's states and breaks each property only with its bug; and the
// acceptance of M7-O05: a broken plugin never holds a turn up, and the turns after it run on core's rules.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesDriver } from "../driver/rules-driver";
import { actions, init, SRCS, step, stepViolations, view, violations, type Action, type Bug, type Config, type Src, type State } from "../reference/rules";
import { createRulesDriver } from "../../desktop/spec-adapters/rules-adapter";

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const one = <T>(list: T[], rnd: () => number) => list[Math.floor(rnd() * list.length)]!;

const dirs: string[] = [];
const drivers: RulesDriver[] = [];
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms).then(() => {});
beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
afterEach(async () => {
  for (const driver of drivers.splice(0)) await driver.close();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = async (start: Src) => {
  const dataDir = mkdtempSync(join(tmpdir(), "spec-rules-"));
  dirs.push(dataDir);
  const driver = await createRulesDriver({ dataDir, start, wait });
  drivers.push(driver);
  return driver;
};
const drive = (driver: RulesDriver, a: Action) => {
  switch (a.type) {
    case "Send": return driver.send(a.say);
    case "Answer": return driver.answer();
    case "Timeout": return driver.timeout();
    case "Break": return driver.brk(a.s);
    case "StartWaiting": throw new Error("only the await bug has waiting turns");
  }
};

describe("orchestration rules (spec/models/rules)", () => {
  it("random walks: the app and the reference agree after every step, and no property fails", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const rnd = random(seed);
      const cfg: Config = { maxTurns: 4, maxBreaks: 3, start: one([...SRCS], rnd), bug: "none" };
      const driver = await open(cfg.start);
      let s = init(cfg);
      const walk: string[] = [];
      for (let i = 0; i < 14; i++) {
        const options = actions(s, cfg);
        if (!options.length) break;
        const a = one(options, rnd);
        walk.push(JSON.stringify(a));
        const n = step(s, cfg, a);
        expect(stepViolations(s, n), `seed ${seed}: ${walk.join(" ")}`).toEqual([]);
        seen.add(a.type === "Answer" || a.type === "Timeout" ? `${a.type}:${s.flight}` : a.type);
        s = n;
        await drive(driver, a);
        expect(driver.view(), `seed ${seed}: ${walk.join(" ")}`).toEqual(view(s));
        expect(violations(s), `seed ${seed}`).toEqual([]);
      }
    }
    expect([...seen].sort()).toEqual(["Answer:edited", "Answer:good", "Answer:throws", "Break", "Send",
      "Timeout:edited", "Timeout:good", "Timeout:hangs", "Timeout:throws"]);
  }, 60_000);

  it("acceptance: a broken plugin (edited, off, hanging) never holds a turn up, and the turns after it take core's rules, with one notice", async () => {
    for (const broken of ["edited", "throws", "hangs"] as const) {
      const driver = await open("good");
      await driver.send(true);
      await driver.answer();
      await driver.send(true);
      expect(driver.view(), broken).toEqual({ rules: "plugin", asking: true, said: 0, used: "plugin" });
      await driver.answer();
      await driver.brk(broken);
      // The turn starts at once, with what is there, while the plugin is asked.
      await driver.send(true);
      expect(driver.view(), broken).toEqual({ rules: "plugin", asking: true, said: 0, used: "plugin" });
      if (broken === "hangs") await driver.timeout(); else await driver.answer();
      expect(driver.view(), broken).toEqual({ rules: "core", asking: false, said: 1, used: "plugin" });
      // Every later turn runs on core's rules, and the user is not told again.
      for (let i = 0; i < 2; i++) {
        await driver.send(true);
        if (broken === "hangs") await driver.timeout(); else await driver.answer();
      }
      expect(driver.view(), broken).toEqual({ rules: "core", asking: false, said: 1, used: "core" });
      // Put right, the plugin's text is back on the next answer.
      await driver.brk("good");
      await driver.send(false);
      await driver.answer();
      expect(driver.view(), broken).toEqual({ rules: "plugin", asking: false, said: 0, used: "core" });
    }
  });

  it("the reference has the model's state space (TLC: 542 distinct states for OrchestrationRules.cfg), and each bug breaks its property as OrchestrationRules_bug_*.cfg do", () => {
    const explore = (cfg: Config) => {
      const first = init(cfg);
      const seen = new Map<string, State>([[JSON.stringify(first), first]]);
      const failed = new Set<string>();
      const queue = [first];
      while (queue.length) {
        const s = queue.shift()!;
        for (const name of violations(s)) failed.add(name);
        const next = actions(s, cfg);
        // AskEnds: an ask that nothing can end.
        if (s.flight !== "none" && !next.some((a) => a.type === "Answer" || a.type === "Timeout")) failed.add("AskEnds");
        for (const a of next) {
          const n = step(s, cfg, a);
          for (const name of stepViolations(s, n)) failed.add(name);
          const key = JSON.stringify(n);
          if (!seen.has(key)) { seen.set(key, n); queue.push(n); }
        }
      }
      return { states: seen.size, failed: [...failed].sort() };
    };
    const tlc: Config = { maxTurns: 3, maxBreaks: 2, start: "good", bug: "none" };
    expect(explore(tlc)).toEqual({ states: 542, failed: [] });
    const broken: [Bug, string][] = [["nopin", "OnlyPinned"], ["keeplast", "CoreAfterFailure"], ["notimeout", "AskEnds"],
      ["await", "NeverWaits"], ["noticeeach", "ToldOnce"], ["silent", "SaysIt"]];
    for (const [bug, property] of broken) expect(explore({ ...tlc, bug }).failed, bug).toContain(property);
  });
});
