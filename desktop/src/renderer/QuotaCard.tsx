import { countdown, hasReset, percent, resetDay, type LimitWindow } from "./usage-text";

/** One quota ring card: the ring is how much is USED, then the window and when it starts over. */
export function QuotaCard({ engine, title, window, now, weekly = false, lastKnown = false, unavailable = "unavailable" }: {
  engine: string; title: string; window: LimitWindow | null; now: number; weekly?: boolean; lastKnown?: boolean;
  /** Words shown when there is no reading (default "unavailable"). */
  unavailable?: string;
}) {
  const reset = window ? hasReset(window, now) : false;
  const used = window && !reset ? window.used : null;
  const value = window ? percent(window, now) : "–";
  const timing = window ? (weekly ? resetDay(window, now) : countdown(window, now)) : unavailable;
  const detail = window && lastKnown ? `Last-known${timing ? ` · ${timing}` : ""}` : timing;
  return <div className="quick-usage-card" role="group" aria-label={`${engine} ${title} limit, ${window ? `${value} used` : unavailable}${detail ? `, ${detail}` : ""}`}>
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
