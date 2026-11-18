// bot.json's `routineLast`: bad entries are left out, a key like "__proto__" stays data, and a run time that a Date cannot hold
// is no time at all (its `toISOString` would throw inside the routines view).
import { expect, it } from "vitest";
import { fromRoutineLast, lastTime } from "../../src/core/routine-last";

it("keeps good entries, leaves out bad ones, and keeps a prototype-like id as plain data", () => {
  const raw = JSON.parse('{"a":{"at":1000,"result":"sent"},"b":{"at":"x","result":"sent"},"c":{"at":5,"result":"weird"},"d":null,"e":[1],"__proto__":{"at":7,"result":"ok"}}');
  const out = fromRoutineLast(raw);
  expect(Object.keys(out).sort()).toEqual(["__proto__", "a"]);
  expect(Object.hasOwn(out, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  expect(fromRoutineLast([1])).toEqual({});
  expect(fromRoutineLast("x")).toEqual({});
});

it("a time outside what a Date holds gives null, never a throw", () => {
  expect(lastTime(Date.UTC(2026, 10, 18))).toBe("2026-11-18T00:00:00.000Z");
  expect(lastTime(1e20)).toBeNull();
  expect(lastTime(-1e20)).toBeNull();
  expect(lastTime(Number.NaN)).toBeNull();
  expect(lastTime(8.64e15 + 1)).toBeNull();
  expect(lastTime(8.64e15)).not.toBeNull();
});

it("a last-run record that cannot be saved never disturbs the run: the routine is dispatched, the failure is logged, nothing throws", async () => {
  const { BotRoutines } = await import("../../src/core/bot/bot-routines");
  const logs: string[] = [];
  const dispatched: string[] = [];
  const ctx = { store: { saveSetting() { throw new Error("disk full"); } }, log: (line: string) => logs.push(line) };
  const routines = new BotRoutines({ readOnly: false } as never, ctx as never);
  routines.dispatchRoutine = ((job: { task: string }) => { dispatched.push(job.task); }) as never;
  expect(() => routines.runRoutine("cron:0 3 * * * Nightly: tidy", { id: "x", task: "Nightly: tidy" } as never, Date.now())).not.toThrow();
  expect(dispatched).toEqual(["Nightly: tidy"]);
  expect(logs).toEqual(["routine last run not kept: disk full"]);
});
