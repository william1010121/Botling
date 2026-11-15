// Test knob (fu-callin-outbox): `BOTLING_SERVER_CALLIN_CRASH=guest=<file>,host=<file>` kills this process (SIGKILL: no shutdown
// at all) at the one moment each side's durable step just committed, so a two-process test hits the crash windows exactly
// instead of racing them:
//   guest  B: the transaction that marks a call-in answered AND queues its answer committed; the queue is not pumped yet.
//   host   A: the transaction of a late `callin.reply` committed (record used up, late line staged); nothing is posted yet.
// A point fires only while its file holds `armed` (the test writes it right before the wave), and then writes `hit:<callId>`
// first, so a restart with the same environment does not die again and the test sees exactly which call-in it was.
// Read only when `BOTLING_AGENT=fake` (the packaged app forces `claude`, so a user's environment never kills a server);
// a malformed value throws at start, like the other knobs.
import { readFileSync, writeFileSync } from "node:fs";

export const CALLIN_CRASH_ENV = "BOTLING_SERVER_CALLIN_CRASH";

export type CallInCrashPoint = "guest" | "host";
/** Called at a crash point; returns normally unless the point is armed (then the process is gone). */
export type CallInCrash = (point: CallInCrashPoint, callId: string) => void;

const POINTS: Record<string, CallInCrashPoint> = { guest: "guest", host: "host" };

/** The crash hook from the environment, or null (unset, or not the fake agent). */
export function callInCrash(env: Record<string, string | undefined>): CallInCrash | null {
  const text = (env[CALLIN_CRASH_ENV] ?? "").trim();
  if (!text || env.BOTLING_AGENT !== "fake") return null;
  const files = new Map<CallInCrashPoint, string>();
  for (const part of text.split(",")) {
    const at = part.indexOf("=");
    const name = at > 0 ? part.slice(0, at).trim() : "";
    const file = at > 0 ? part.slice(at + 1).trim() : "";
    if (!name || !file || !Object.hasOwn(POINTS, name)) throw new Error(`${CALLIN_CRASH_ENV}: "${part}" is not point=file (guest, host)`);
    files.set(POINTS[name]!, file);
  }
  return (point, callId) => {
    const file = files.get(point);
    if (!file) return;
    let armed = false;
    try { armed = readFileSync(file, "utf8").trim() === "armed"; } catch { return; }
    if (!armed) return;
    try { writeFileSync(file, `hit:${callId}`); } catch { return; }
    process.kill(process.pid, "SIGKILL");
  };
}
