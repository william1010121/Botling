// 1.x's gear-popover quota rings. Read the core's saved CLI readings on open, after
// turns, and each minute; the minute tick also advances reset/countdown/stale text.
import { AntigravityQuota } from "./AntigravityQuota";
import { QuotaCard } from "./QuotaCard";
import { useEffect, useState } from "react";
import type { UsageView } from "../contract";
import type { Client } from "./client";
import { asOf, staleSince } from "./usage-text";

type QuotaStatus = NonNullable<UsageView["quotaStatus"]>["claude"];
const quotaProblems: Record<Exclude<QuotaStatus, "available">, string> = {
  auth_required: "sign-in required",
  token_expired: "credentials expired",
  auth_rejected: "quota authentication rejected; cause unknown",
  forbidden: "quota access denied",
  timeout: "quota request timed out",
  network_error: "quota network error",
  invalid_response: "invalid quota response",
  missing: "quota readings missing",
  cli_unavailable: "CLI unavailable",
};

// One refresh loop per renderer client, shared by both quota surfaces. Closing
// the final surface removes the listener and timer; the core owns quota history.
type UsageState = { usage: UsageView | null; now: number; failed: boolean; loading: boolean };
const usageSessions = new WeakMap<Client, ReturnType<typeof createUsageSession>>();
function createUsageSession(client: Client) {
  let state: UsageState = {usage: null, now: Date.now(), failed: false, loading: true};
  const listeners = new Set<(state: UsageState) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | undefined;
  let pending = false, again = false, lastAttempt = -Infinity;
  const publish = () => { for (const listener of listeners) listener(state); };
  const load = (turnFinished = false) => {
    if (pending) { if (turnFinished) again = true; return; }
    // Manual retry cannot create a tight loop. A completed turn may retry now.
    if (!turnFinished && Date.now() - lastAttempt < 2_000) return;
    clearTimeout(timer);
    lastAttempt = Date.now(); pending = true;
    state = {...state, now: Date.now(), loading: true}; publish();
    void client.request({type: "usage.view"}).then(usage => {
      state = {...state, usage, failed: false};
    }, () => { state = {...state, failed: true}; }).finally(() => {
      pending = false; state = {...state, loading: false}; publish();
      if (!listeners.size) { again = false; return; }
      if (again) { again = false; load(true); return; }
      const quota = state.usage?.antigravity;
      timer = setTimeout(() => load(), !state.failed && quota?.status === "unavailable" && quota.reason === "busy" ? 2_000 : 60_000);
    });
  };
  return {
    get: () => state,
    retry: () => load(),
    subscribe(listener: (state: UsageState) => void) {
      listeners.add(listener); listener(state);
      if (listeners.size === 1) {
        off = client.onEvent(({event}) => { if (event.type === "turn.finished") load(true); });
        // Reopening is not a new polling loop or a reason to bypass retry bounds.
        if (!pending) {
          const delay = Math.max(0, 2_000 - (Date.now() - lastAttempt));
          if (delay) timer = setTimeout(() => load(), delay); else load();
        }
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { clearTimeout(timer); off?.(); off = undefined; }
      };
    },
  };
}
export function useUsageRefresh(client: Client) {
  let session = usageSessions.get(client);
  if (!session) { session = createUsageSession(client); usageSessions.set(client, session); }
  const [state, setState] = useState(session.get);
  useEffect(() => session.subscribe(setState), [session]);
  return {...state, retry: session.retry};
}

export function QuickSettingsUsage({ client }: { client: Client }) {
  const {usage, now, failed, loading, retry} = useUsageRefresh(client);

  const claude = usage?.claude ?? { fiveHour: null, week: null };
  const codex = usage?.codex ?? { fiveHour: null, week: null };
  const problem = (engine: "claude" | "codex") => {
    if (failed) return "quota refresh failed";
    // Keep unknown future failure statuses visible alongside retained readings.
    const status: string | undefined = usage?.quotaStatus?.[engine];
    if (!status || status === "available") return null;
    if (status === "token_expired" && engine === "claude") {
      return "credentials expired; a normal Claude session may refresh them";
    }
    return Object.hasOwn(quotaProblems, status)
      ? quotaProblems[status as keyof typeof quotaProblems]
      : "quota readings unavailable";
  };
  const claudeProblem = problem("claude"), codexProblem = problem("codex");
  const since = (limits: typeof claude) => {
    const seen = staleSince(limits, now);
    return seen === null ? null : <p className="quick-usage-note">{asOf(seen, now)}</p>;
  };
  return <section className="quick-usage" aria-label="Subscription usage">
    <h3>Claude</h3>
    <div className="quick-usage-cards">
      <QuotaCard engine="Claude" title="5 hours" window={claude.fiveHour} now={now} lastKnown={!!claudeProblem} />
      <QuotaCard engine="Claude" title="Week" window={claude.week} now={now} lastKnown={!!claudeProblem} weekly />
    </div>
    {claudeProblem && <p className="quick-usage-note" role="status">Claude: {claudeProblem}.</p>}
    {since(claude)}
    <h3>Codex</h3>
    <div className="quick-usage-cards single">
      <QuotaCard engine="Codex" title="Week" window={codex.week} now={now} lastKnown={!!codexProblem} weekly />
    </div>
    {codexProblem && <p className="quick-usage-note" role="status">Codex: {codexProblem}.</p>}
    {since({ fiveHour: null, week: codex.week })}
    <h3>Antigravity</h3>
    <AntigravityQuota quota={usage?.antigravity} now={now} loading={loading} failed={failed} onRetry={retry} />
    {failed && <p className="quick-usage-note" role="alert">
      Quota readings unavailable.{" "}
      <button type="button" onClick={retry}>Retry</button>
    </p>}
  </section>;
}
