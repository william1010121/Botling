// Watch routines: a routine whose instruction is "!command" is a check the app runs itself on its schedule, in the
// bot's folder, without waking the bot; only a failure (non-zero exit, timeout, an "ALERT" line) wakes it, once per
// failing streak (again only after WATCH_REWAKE_MS while it keeps failing, or after it recovered).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { parseRoutine, ScheduledRoutineStore } from "../../src/core/routines";
import { nextWatchState, runWatch, watchCommand, watchFailure, watchPrompt, WATCH_REWAKE_MS, type WatchResult } from "../../src/core/routine-watch";
import { ProcessLedger } from "../../src/core/process/ledger";

const pass: WatchResult = { exit: 0, timedOut: false, output: "all good\n", ranAt: 0 };
const fail: WatchResult = { exit: 3, timedOut: false, output: "disk 97% full\n", ranAt: 0 };
const at = (result: WatchResult, ranAt: number): WatchResult => ({ ...result, ranAt });

describe("watch syntax", () => {
  it("a routine whose instruction starts with ! is a watch; its command is the rest", () => {
    expect(watchCommand("Disk: !df -h / | awk 'NR==2{exit ($5+0>90)}'")).toBe("df -h / | awk 'NR==2{exit ($5+0>90)}'");
    expect(watchCommand("Disk： ! ./check.sh")).toBe("./check.sh");
    expect(watchCommand("Disk: check the disk")).toBeNull();
    expect(watchCommand("Disk: !")).toBeNull();
    expect(watchCommand("!no name")).toBeNull();
    const job = parseRoutine("*/10 * * * * Disk: !./check-disk.sh");
    expect(job && watchCommand(job.task)).toBe("./check-disk.sh");
  });

  it("what fails: a non-zero exit, a timeout, or a line starting with ALERT", () => {
    expect(watchFailure(pass)).toBeNull();
    expect(watchFailure(fail)).toBe("exit code 3");
    expect(watchFailure({ ...pass, exit: null, timedOut: true })).toBe("timed out");
    expect(watchFailure({ ...pass, output: "ok\nALERT: queue stuck\n" })).toBe("ALERT line");
    expect(watchFailure({ ...pass, output: "no ALERT here\n" })).toBeNull();
  });
});

describe("the storm rule", () => {
  it("pass: nothing wakes, the run is recorded", () => {
    const { state, wake } = nextWatchState(undefined, at(pass, 1_000));
    expect(wake).toBe(false);
    expect(state).toMatchObject({ lastRun: 1_000, ok: true, exit: 0, failingSince: null });
  });

  it("fail: one wake; repeated failures do not wake again; after the cool-down it reminds once more", () => {
    let { state, wake } = nextWatchState(undefined, at(fail, 1_000));
    expect(wake).toBe(true);
    expect(state).toMatchObject({ ok: false, failingSince: 1_000, wokeAt: 1_000 });
    for (let minute = 1; minute <= 30; minute++) {
      ({ state, wake } = nextWatchState(state, at(fail, 1_000 + minute * 600_000)));
      if (1_000 + minute * 600_000 - 1_000 < WATCH_REWAKE_MS) expect(wake).toBe(false);
    }
    // 30 runs 10 minutes apart = 5 hours: still within the cool-down.
    expect(state.wokeAt).toBe(1_000);
    ({ state, wake } = nextWatchState(state, at(fail, 1_000 + WATCH_REWAKE_MS)));
    expect(wake).toBe(true);
    expect(state.wokeAt).toBe(1_000 + WATCH_REWAKE_MS);
    expect(state.failingSince).toBe(1_000);
  });

  it("recovered: re-armed, so the next failure wakes at once", () => {
    let { state } = nextWatchState(undefined, at(fail, 1_000));
    let wake: boolean;
    ({ state, wake } = nextWatchState(state, at(pass, 2_000)));
    expect(wake).toBe(false);
    expect(state).toMatchObject({ ok: true, failingSince: null, wokeAt: null });
    ({ state, wake } = nextWatchState(state, at(fail, 3_000)));
    expect(wake).toBe(true);
  });

  it("the wake message names the watch, the command, why, and the output's tail", () => {
    const text = watchPrompt("Disk", "./check.sh", { ...fail, output: `${"x\n".repeat(200)}last line\n` });
    expect(text).toContain('watch "Disk"');
    expect(text).toContain("./check.sh");
    expect(text).toContain("exit code 3");
    expect(text).toContain("last line");
    expect(text.length).toBeLessThan(3_000);
  });
});

describe("running a watch", () => {
  const plain = () => { process.env.BOTLING_PLAIN_SHELL = "1"; };

  it("runs in the folder, gives the exit code and the output", async () => {
    plain();
    const dir = tempDir("watch");
    writeFileSync(join(dir, "flag"), "here");
    const ok = await runWatch("cat flag; echo err >&2", dir);
    expect(ok).toMatchObject({ exit: 0, timedOut: false });
    expect(ok.output).toContain("here");
    expect(ok.output).toContain("err");
    const bad = await runWatch("echo broken; exit 4", dir);
    expect(bad).toMatchObject({ exit: 4, timedOut: false });
  });

  it("stops a command that runs too long", async () => {
    plain();
    const result = await runWatch("sleep 5", tempDir("watch"), 300);
    expect(result).toMatchObject({ timedOut: true, exit: null });
  });

  it("keeps its group in the process ledger while it runs: a start after the app died ends it (RoutineWatch.tla NoOverlap)", async () => {
    plain();
    const dir = tempDir("watch");
    const file = join(dir, "children.json");
    const heard: [number, boolean][] = [];
    const ledger = new ProcessLedger(file);
    const run = runWatch("sleep 30", dir, 60_000, (pid, alive) => { heard.push([pid, alive]); if (alive) ledger.record(pid); else ledger.forget(pid); });
    const pid = heard[0]![0];
    expect(heard).toEqual([[pid, true]]);
    // The next core's start (server.ts) ends what the ledger names.
    expect(new ProcessLedger(file).endLeftovers()).toEqual([pid]);
    expect(await run).toMatchObject({ exit: null, timedOut: false });
    expect(heard).toEqual([[pid, true], [pid, false]]);
    const done = await runWatch("true", dir, 60_000, (p, alive) => heard.push([p, alive]));
    expect(done.exit).toBe(0);
    expect(heard.slice(2).map(([, alive]) => alive)).toEqual([true, false]);
  });
});

describe("app_routines kind=watch", () => {
  it("is saved as a recurring schedule whose task is 'Name: !command', and listed as kind watch", () => {
    const dir = tempDir("watch");
    mkdirSync(dir, { recursive: true });
    const store = new ScheduledRoutineStore(join(dir, "scheduled-routines.json"));
    const made = store.perform({ operation: "create", kind: "watch", cron: "*/10 * * * *", task: "Disk", command: "./check-disk.sh", request_id: "w1", timezone: "UTC" });
    expect(made).toMatchObject({ kind: "watch", cron: "*/10 * * * *", command: "./check-disk.sh", task: "Disk: !./check-disk.sh" });
    const saved = JSON.parse(readFileSync(join(dir, "scheduled-routines.json"), "utf8")).routines[0];
    expect(saved).toMatchObject({ kind: "recurring", task: "Disk: !./check-disk.sh" });
    // A retry with the same request_id is the same schedule.
    expect(store.perform({ operation: "create", kind: "watch", cron: "*/10 * * * *", task: "Disk", command: "./check-disk.sh", request_id: "w1", timezone: "UTC" })).toMatchObject({ id: (made as any).id });
    expect((store.perform({ operation: "list" }) as any).routines[0]).toMatchObject({ kind: "watch", command: "./check-disk.sh" });
    expect(() => store.perform({ operation: "create", kind: "watch", cron: "*/10 * * * *", task: "Disk", request_id: "w2" })).toThrow(/command/);
    expect(() => store.perform({ operation: "create", kind: "watch", task: "Disk", command: "x", request_id: "w3" })).toThrow(/cron/);
    store.cronFile.create(["*/5 * * * * Queue: !./queue-ok.sh"]);
    expect((store.perform({ operation: "list" }) as any).routines.find((r: any) => r.id.startsWith("cron:"))).toMatchObject({ kind: "legacy_watch", command: "./queue-ok.sh" });
  });
});
