// The refresh loop of both usage surfaces (the gear popover's rings, Settings → Usage): read the core's saved CLI
// readings on open, after a bot's turn, and each minute; the minute tick also advances reset/countdown/stale text.
// What it reads from is a `UsageSource` (the frame's, in web.ts), so the loop is the same wherever it runs.
import { useEffect, useState } from "react";
import type { UsageView } from "../../../../Web/host/src/api";

/** Where the usage comes from: a read, and word that a bot's turn finished (returns how to stop listening). */
export interface UsageSource {
  view(): Promise<UsageView>;
  onTurnFinished(fn: () => void): () => void;
}

export type UsageState = { usage: UsageView | null; now: number; failed: boolean; loading: boolean };

// One refresh loop per source, shared by both quota surfaces of one page. Closing the final surface removes the
// listener and timer; the core owns quota history.
const sessions = new WeakMap<UsageSource, ReturnType<typeof createUsageSession>>();
export function createUsageSession(source: UsageSource) {
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
    void source.view().then(usage => {
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
        off = source.onTurnFinished(() => load(true));
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
export function useUsageRefresh(source: UsageSource) {
  let session = sessions.get(source);
  if (!session) { session = createUsageSession(source); sessions.set(source, session); }
  const [state, setState] = useState(session.get);
  useEffect(() => session.subscribe(setState), [session]);
  return {...state, retry: session.retry};
}
