// The fault plan and the process helpers of the airplane-mode check (the same code as airplane.test.ts, M2 check 2), for the shell-alone
// variant (shell-alone-airplane.test.ts, M7-08). airplane.test.ts keeps its own copy: it is M2's evidence and is not edited here.
import { execFileSync, spawnSync } from "node:child_process";

export type Fault = "offline" | "reload" | "browser-kill" | "server-kill";
export const KINDS: Fault[] = ["offline", "reload", "browser-kill", "server-kill"];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Five faults at distinct command positions of `commands`, every kind at least once, in a seeded order. */
export function plan(random: () => number, commands: number): Map<number, Fault> {
  const kinds = [...KINDS, KINDS[Math.floor(random() * KINDS.length)]!];
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!]; }
  const at = new Set<number>();
  const lo = Math.max(2, Math.floor(commands * 0.05)), hi = Math.max(lo + kinds.length, commands - 5);
  while (at.size < kinds.length) at.add(lo + Math.floor(random() * (hi - lo)));
  const positions = [...at].sort((x, y) => x - y);
  return new Map(positions.map((p, i) => [p, kinds[i]!]));
}

/** Every process of the browser that uses `profile`: its process group, and any other process holding its files. */
export function browserProcesses(profile: string): Array<{ pid: number; command: string }> {
  const rows = execFileSync("ps", ["-axo", "pid=,pgid=,command="], { encoding: "utf8" }).split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }));
  const leaders = new Set(rows.filter((row) => row.command.includes(profile)).map((row) => row.pgid));
  const pids = new Set(rows.filter((row) => leaders.has(row.pgid)).map((row) => row.pid));
  const holders = spawnSync("lsof", ["-t", "+D", profile], { encoding: "utf8" }).stdout ?? "";
  for (const pid of holders.split("\n").filter(Boolean)) pids.add(Number(pid));
  pids.delete(process.pid);
  return rows.filter((row) => pids.has(row.pid)).map(({ pid, command }) => ({ pid, command: command.split(" ")[0]!.split("/").pop()! }));
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
