// ProcessLedger: ends what a dead core left, on POSIX (real) and on the Windows path (fakes).
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcessLedger } from "../../src/core/process/ledger";
import type { ProcessDeps } from "../../src/core/process/kill-tree";
import { alive, tempDir, until } from "../helpers";

describe.skipIf(process.platform === "win32")("ProcessLedger on this OS", () => {
  it("ends a recorded group left by a dead core, and keeps one with another start time", async () => {
    const file = join(tempDir("ledger"), "children.json");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const ledger = new ProcessLedger(file);
    ledger.record(child.pid!);
    const entries = JSON.parse(readFileSync(file, "utf8"));
    expect(entries[0].pgid).toBe(child.pid);
    // Pretend a core that no longer exists wrote it.
    writeFileSync(file, JSON.stringify([{ ...entries[0], core: 2 ** 22 + 99 }, { pgid: process.pid, started: "not this process", core: 2 ** 22 + 99 }]));
    expect(ledger.endLeftovers()).toEqual([child.pid]);
    await until(() => !alive(child.pid!), { what: "leftover dead" });
    expect(alive(process.pid)).toBe(true); // reused pid (different start time) is never killed
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });
});

describe("ProcessLedger on the Windows path", () => {
  const windows = (alivePids: number[], started: Record<number, string>) => {
    const calls: string[] = [];
    const deps: ProcessDeps = {
      platform: "win32",
      kill: (pid) => { if (!alivePids.includes(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }); },
      exec: (_file, args) => { const pid = Number(/-Id (\d+)/.exec(args.join(" "))![1]); if (!(pid in started)) throw new Error("no process"); return `${started[pid]}\n`; },
      taskkill: (args) => { calls.push(args.join(" ")); return 0; },
      readFile: () => { throw new Error("ENOENT"); },
    };
    return { deps, calls };
  };

  it("records the pid with its start time and ends the tree with taskkill (no early return on win32)", () => {
    const file = join(tempDir("ledger-win"), "children.json");
    const { deps, calls } = windows([500], { 500: "2026-10-30T12:00:00.0000000Z" });
    const ledger = new ProcessLedger(file, deps);
    ledger.record(500);
    const [entry] = JSON.parse(readFileSync(file, "utf8"));
    expect(entry).toMatchObject({ pgid: 500, started: "2026-10-30T12:00:00.0000000Z" });
    writeFileSync(file, JSON.stringify([{ ...entry, core: 999_999 }]));
    expect(ledger.endLeftovers()).toEqual([500]);
    expect(calls).toEqual(["/PID 500 /T /F"]);
  });

  it("leaves a pid alone when its start time changed, or cannot be read", () => {
    const file = join(tempDir("ledger-win2"), "children.json");
    writeFileSync(file, JSON.stringify([{ pgid: 501, started: "old", core: 999_999 }, { pgid: 502, started: "x", core: 999_999 }]));
    const { deps, calls } = windows([501, 502], { 501: "new" }); // 502: PowerShell gives nothing
    expect(new ProcessLedger(file, deps).endLeftovers()).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(file) && JSON.parse(readFileSync(file, "utf8"))).toEqual([]);
  });

  it("records nothing when the start time is unavailable", () => {
    const file = join(tempDir("ledger-win3"), "children.json");
    new ProcessLedger(file, windows([7], {}).deps).record(7);
    expect(existsSync(file)).toBe(false);
  });
});
