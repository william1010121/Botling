// killTree / processStartTime: real process trees on this OS, and each platform's branch through fakes.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { groupAlive, groupMembers, killTree, linuxStartTicks, processAlive, processCommandLines, processStartTime, signalGroup, systemDeps, type ProcessDeps } from "../../src/core/process/kill-tree";
import { alive, until } from "../helpers";

/** A fake OS: records calls, answers from tables. */
function fake(platform: NodeJS.Platform, over: Partial<ProcessDeps> = {}) {
  const calls: string[] = [];
  const deps: ProcessDeps = {
    platform,
    kill: (pid, signal) => { calls.push(`kill ${pid} ${signal}`); },
    exec: (file, args) => { calls.push(`exec ${file} ${args.join(" ")}`); return ""; },
    taskkill: (args) => { calls.push(`taskkill ${args.join(" ")}`); return 0; },
    readFile: (path) => { calls.push(`read ${path}`); throw new Error("ENOENT"); },
    ...over,
  };
  return { deps, calls };
}
const errno = (code: string) => Object.assign(new Error(code), { code });

describe.skipIf(process.platform === "win32")("killTree on real processes (POSIX)", () => {
  // A leader in its own group that starts a helper in the same group; prints the helper's pid.
  const tree = async () => {
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)";
    const leader = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const helper = await new Promise<number>((resolve) => leader.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
    return { leader, helper, pid: leader.pid! };
  };

  it("ends the leader and its helper, and reports the group gone", async () => {
    const { helper, pid } = await tree();
    expect(groupAlive(pid)).toBe(true);
    expect(groupMembers(pid)).toEqual(expect.arrayContaining([pid, helper]));
    expect(killTree(pid, "SIGKILL")).toBe(true);
    await until(() => !alive(pid) && !alive(helper), { what: "both dead" });
    await until(() => !groupAlive(pid), { what: "group gone" });
    expect(killTree(pid, "SIGKILL")).toBe(false); // already gone
  });

  it("signals a process that is not a group leader alone", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); // same group as the test runner
    try {
      expect(killTree(child.pid!, "SIGKILL")).toBe(true);
      await until(() => !alive(child.pid!), { what: "child dead" });
    } finally { child.kill("SIGKILL"); }
  });

  it("refuses pids that would hit everything or nothing", () => {
    for (const pid of [0, 1, -5, 1.5, Number.NaN]) expect(killTree(pid, "SIGKILL")).toBe(false);
  });

  it("reads a stable start time of a live process and null for a dead one", () => {
    const first = processStartTime(process.pid);
    expect(first).toBeTruthy();
    expect(processStartTime(process.pid)).toBe(first);
    expect(processStartTime(2 ** 22 + 12345)).toBeNull();
    expect(processAlive(process.pid)).toBe(true);
  });

  it("lists command lines, this process among them", () => {
    expect(processCommandLines().some((line) => line.includes(process.execPath) || line.includes("node") || line.includes("vitest"))).toBe(true);
  });
});

describe("killTree platform branches", () => {
  it("POSIX signals the group, then falls back to the pid", () => {
    const { deps, calls } = fake("linux", { kill: (pid, signal) => { calls.push(`kill ${pid} ${signal}`); if (pid < 0) throw errno("ESRCH"); } });
    expect(killTree(4242, "SIGTERM", deps)).toBe(true);
    expect(calls).toEqual(["kill -4242 SIGTERM", "kill 4242 SIGTERM"]);
  });

  it("group-only signalling never falls back to a reused pid", () => {
    const { deps, calls } = fake("linux", { kill: (pid, signal) => { calls.push(`kill ${pid} ${signal}`); throw errno("ESRCH"); } });
    expect(signalGroup(4242, "SIGKILL", deps)).toBe(false);
    expect(calls).toEqual(["kill -4242 SIGKILL"]);
  });

  it("POSIX reports false when neither exists", () => {
    const { deps } = fake("darwin", { kill: () => { throw errno("ESRCH"); } });
    expect(killTree(4242, "SIGKILL", deps)).toBe(false);
  });

  it("Windows runs taskkill /T /F whatever the signal, and never process.kill", () => {
    const { deps, calls } = fake("win32");
    expect(killTree(77, "SIGTERM", deps)).toBe(true);
    expect(killTree(77, "SIGKILL", deps)).toBe(true);
    expect(calls).toEqual(["taskkill /PID 77 /T /F", "taskkill /PID 77 /T /F"]);
    expect(killTree(1, "SIGKILL", deps)).toBe(false);
  });

  it("Windows reports false when taskkill fails or cannot run", () => {
    expect(killTree(77, "SIGKILL", fake("win32", { taskkill: () => 128 }).deps)).toBe(false);
    expect(killTree(77, "SIGKILL", fake("win32", { taskkill: () => null }).deps)).toBe(false);
  });

  it("group existence: EPERM counts as alive, ESRCH as gone; Windows asks about the process", () => {
    expect(groupAlive(5, fake("linux", { kill: () => { throw errno("EPERM"); } }).deps)).toBe(true);
    expect(groupAlive(5, fake("linux", { kill: () => { throw errno("ESRCH"); } }).deps)).toBe(false);
    const win = fake("win32");
    expect(groupAlive(5, win.deps)).toBe(true);
    expect(win.calls).toEqual(["kill 5 0"]);
  });
});

describe("processStartTime platform branches", () => {
  it("darwin uses ps lstart with a pinned locale", () => {
    const { deps, calls } = fake("darwin", { exec: (file, args) => { calls.push(`${file} ${args.join(" ")}`); return "Thu Oct 30 12:00:00 2026\n"; } });
    expect(processStartTime(10, deps)).toBe("Thu Oct 30 12:00:00 2026");
    expect(calls).toEqual(["ps -o lstart= -p 10"]);
  });

  it("linux reads /proc stat, counting from the last parenthesis", () => {
    const stat = "10 (a) b (weird)) S 1 10 10 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615";
    expect(linuxStartTicks(stat)).toBe("987654");
    const { deps, calls } = fake("linux", { readFile: (path) => { calls.push(`read ${path}`); return stat; } });
    expect(processStartTime(10, deps)).toBe("987654");
    expect(calls).toEqual(["read /proc/10/stat"]);
  });

  it("linux falls back to ps when /proc is missing or malformed", () => {
    const viaPs = fake("linux", { exec: () => "Thu Oct 30 12:00:00 2026\n" });
    expect(processStartTime(10, viaPs.deps)).toBe("Thu Oct 30 12:00:00 2026");
    expect(linuxStartTicks("garbage")).toBeNull();
    expect(processStartTime(10, fake("linux", { readFile: () => "garbage", exec: () => "x\n" }).deps)).toBe("x");
  });

  it("windows asks PowerShell for a UTC round-trip time", () => {
    const seen: string[][] = [];
    const { deps } = fake("win32", { exec: (file, args) => { seen.push([file, ...args]); return "2026-10-30T12:00:00.0000000Z\r\n"; } });
    expect(processStartTime(10, deps)).toBe("2026-10-30T12:00:00.0000000Z");
    expect(seen[0]![0]).toBe("powershell.exe");
    expect(seen[0]!.join(" ")).toContain("Get-Process -Id 10");
    expect(seen[0]!.join(" ")).toContain("ToUniversalTime().ToString('o'");
  });

  it("degrades to null instead of throwing when the OS gives nothing", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(processStartTime(10, fake(platform, { exec: () => { throw new Error("no such tool"); } }).deps)).toBeNull();
      expect(processStartTime(10, fake(platform, { exec: () => "  \n" }).deps)).toBeNull();
    }
  });

  it("the system deps follow process.platform", () => {
    expect(systemDeps.platform).toBe(process.platform);
  });
});
