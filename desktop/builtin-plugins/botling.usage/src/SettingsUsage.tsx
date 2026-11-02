// Settings → Usage (1.x's usage page, Phase 5c): cost and tokens today, the subscriptions' limits as Claude and
// Codex last reported them (they come with bots' turns only), by bot, and the days before. Read again each minute.
import type { ReactNode } from "react";
import { AntigravityQuota } from "./AntigravityQuota";
import { asOf, countdown, dollars, isEmpty, percent, resetDay, staleSince, tokenCount, type Limits } from "./usage-text";
import { useUsageRefresh, type UsageSource } from "./usage-session";

function Group({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

function Row({ label, children, hint }: { label: string; children?: ReactNode; hint?: string }) {
  return (
    <div className="settings-row">
      <div className="settings-label">{label}{hint && <div className="settings-hint">{hint}</div>}</div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

/**
 * Settings → Usage (1.x's usage page, Phase 5c): cost and tokens today, the subscriptions' limits as Claude and
 * Codex last reported them (they come with bots' turns only), by bot, and the days before. Read again each minute.
 */
export function SettingsUsage({ source }: { source: UsageSource }) {
  const {usage, now, loading, failed, retry} = useUsageRefresh(source);
  const tokens = usage?.tokens;
  const available = usage?.spendingStatus === "available";
  return (
    <>
      {loading && !usage && <p className="settings-note" role="status">Loading usage…</p>}
      {failed && <div className="settings-note" role="alert">
        Usage is unavailable.{" "}
        <button type="button" disabled={loading} onClick={retry}>Retry</button>
      </div>}
      {usage && <>
        <Group title="Usage today" note={available && tokens
          ? `${usage.day === localDay(now) ? "" : `${usage.day} · `}In ${tokenCount(tokens.input)} · out ${tokenCount(tokens.output)} · cache write ${tokenCount(tokens.cacheWrite)} · cache read ${tokenCount(tokens.cacheRead)}`
          : undefined}>
          {available && tokens ? <>
            <Row label="Cost"><span className="usage-number">{dollars(usage.spent)}</span></Row>
            <Row label="Tokens"><span className="usage-number">{tokenCount(tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead)}</span></Row>
          </> : <Row label="Recorded usage is unavailable." />}
        </Group>
        <Group title="Subscription limits">
          <LimitRow name="Claude" limits={usage.claude} now={now} />
          <LimitRow name="Codex" limits={usage.codex} now={now} />
          <Row label="Antigravity">
            <AntigravityQuota quota={usage.antigravity} failed={failed} loading={loading} onRetry={retry} />
          </Row>
        </Group>
        {available && <Group title="By bot">
          {!usage.byBot.length && <Row label="No bot has used anything today." />}
          {usage.byBot.map((bot) => <UsageRow key={bot.name} name={bot.name} spent={bot.spent} tokens={bot.tokens} />)}
        </Group>}
        {available && usage.history.length > 0 && <Group title="Earlier days">
          {[...usage.history].reverse().map((day) => <UsageRow key={day.day} name={day.day} spent={day.spent} tokens={day.tokens} />)}
        </Group>}
      </>}
    </>
  );
}

/** "2026-10-26": the local day, as the spending record names it. */
const localDay = (ms: number) => { const date = new Date(ms); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };

function UsageRow({ name, spent, tokens }: { name: string; spent: number; tokens: number }) {
  return (
    <Row label={name}>
      <span className="usage-line"><span className="usage-faint">{tokenCount(tokens)} tokens</span><span className="usage-number usage-cost">{dollars(spent)}</span></span>
    </Row>
  );
}

/** One subscription's 5-hour and weekly use, with when each starts over (1.x's LimitRow). */
function LimitRow({ name, limits, now }: { name: string; limits: Limits; now: number }) {
  const since = staleSince(limits, now);
  return (
    <Row label={name}>
      <span className="usage-limits" aria-label={`${name} limits`}>
        {isEmpty(limits) && <span className="usage-faint">no data</span>}
        {limits.fiveHour && <span>5 hours {percent(limits.fiveHour, now)} · {countdown(limits.fiveHour, now)}</span>}
        {limits.week && <span className="usage-faint">Week {percent(limits.week, now)} · {resetDay(limits.week, now)}</span>}
        {since !== null && <span className="usage-stale">{asOf(since, now)}</span>}
      </span>
    </Row>
  );
}

