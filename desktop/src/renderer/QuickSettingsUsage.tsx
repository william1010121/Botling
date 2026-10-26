// 1.x's gear-popover quota rings. Read the core's saved CLI readings on open, after
// turns, and each minute; the minute tick also advances reset/countdown/stale text.
import { useEffect, useState } from "react";
import type { UsageView } from "../contract";
import type { Client } from "./client";
import { asOf, countdown, hasReset, percent, resetDay, staleSince, type LimitWindow } from "./usage-text";

export function QuickSettingsUsage({ client }: { client: Client }) {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true, pending = false, again = false;
    const load = () => {
      setNow(Date.now());
      if (pending) { again = true; return; }
      pending = true;
      void client.request({ type: "usage.view" }).then(value => {
        if (live) { setUsage(value); setFailed(false); }
      }, () => { if (live) setFailed(true); }).finally(() => {
        pending = false;
        if (live && again) { again = false; load(); }
      });
    };
    load();
    const timer = setInterval(load, 60_000);
    const off = client.onEvent(({ event }) => { if (event.type === "turn.finished") load(); });
    return () => { live = false; clearInterval(timer); off(); };
  }, [client, retry]);

  const claude = usage?.claude ?? { fiveHour: null, week: null };
  const codex = usage?.codex ?? { fiveHour: null, week: null };
  const since = (limits: typeof claude) => {
    const seen = staleSince(limits, now);
    return seen === null ? null : <p className="quick-usage-note">{asOf(seen, now)}</p>;
  };
  return <section className="quick-usage" aria-label="Subscription usage">
    <h3>Claude</h3>
    <div className="quick-usage-cards">
      <QuotaCard engine="Claude" title="5 hours" window={claude.fiveHour} now={now} />
      <QuotaCard engine="Claude" title="Week" window={claude.week} now={now} weekly />
    </div>
    {since(claude)}
    <h3>Codex</h3>
    <div className="quick-usage-cards single">
      <QuotaCard engine="Codex" title="Week" window={codex.week} now={now} weekly />
    </div>
    {since({ fiveHour: null, week: codex.week })}
    {!usage && !failed && <p className="quick-usage-note" role="status">Loading quota readings…</p>}
    {failed && <p className="quick-usage-note" role="alert">
      Quota readings unavailable.{usage ? " Showing the last successful reading." : ""}{" "}
      <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button>
    </p>}
  </section>;
}

function QuotaCard({ engine, title, window, now, weekly = false }: {
  engine: string; title: string; window: LimitWindow | null; now: number; weekly?: boolean;
}) {
  const reset = window ? hasReset(window, now) : false;
  const used = window && !reset ? window.used : null;
  const value = window ? percent(window, now) : "–";
  const detail = window ? (weekly ? resetDay(window, now) : countdown(window, now)) : "unavailable";
  return <div className="quick-usage-card" role="group" aria-label={`${engine} ${title} limit, ${window ? `${value} used` : "unavailable"}${detail ? `, ${detail}` : ""}`}>
    <span className="quick-usage-ring" aria-hidden="true">
      <svg viewBox="0 0 41 41" fill="none">
        <circle cx="20.5" cy="20.5" r="18" stroke="var(--chip)" strokeWidth="5" />
        {used !== null && <circle cx="20.5" cy="20.5" r="18" pathLength="1" stroke={used >= 0.8 ? "var(--orange)" : "var(--blue)"}
          strokeWidth="5" strokeLinecap="round" strokeDasharray={`${used} 1`} />}
      </svg>
      <span>{value}</span>
    </span>
    <span><strong>{title}</strong><small>{detail}</small></span>
  </div>;
}
