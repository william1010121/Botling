// Test knob (M5-03b): `BOTLING_SERVER_CALLIN_TIMERS=stale=<ms>,cap=<ms>,tick=<ms>` shortens the host's wait (M5-02c: 75 s of
// B's silence, a 16 min cap, a 5 s check) so a two-process test can reach "gave up" in seconds. It is read only when
// `BOTLING_AGENT=fake` (the packaged app forces `claude`, so a user's environment can never shorten a real wait), and a
// malformed value throws at start, like the peer timers.
import type { CallInHostOptions } from "./host";

export const CALLIN_TIMERS_ENV = "BOTLING_SERVER_CALLIN_TIMERS";

const NAMES: Record<string, "staleMs" | "capMs" | "tickMs"> = { stale: "staleMs", cap: "capMs", tick: "tickMs" };

/** The host's timer options from the environment (empty when unset or not the fake agent). */
export function callInTimers(env: Record<string, string | undefined>): Pick<CallInHostOptions, "staleMs" | "capMs" | "tickMs"> {
  const text = (env[CALLIN_TIMERS_ENV] ?? "").trim();
  if (!text || env.BOTLING_AGENT !== "fake") return {};
  const timers: Pick<CallInHostOptions, "staleMs" | "capMs" | "tickMs"> = {};
  for (const part of text.split(",")) {
    const match = /^\s*([A-Za-z]+)\s*=\s*(\d{1,9})\s*$/.exec(part);
    const key = match && Object.hasOwn(NAMES, match[1]!) ? NAMES[match[1]!] : undefined;
    if (!match || !key || Number(match[2]) < 10) throw new Error(`${CALLIN_TIMERS_ENV}: "${part}" is not name=milliseconds (stale, cap, tick; at least 10)`);
    timers[key] = Number(match[2]);
  }
  return timers;
}
