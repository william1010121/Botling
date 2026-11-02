// The gear popover's quota rings (1.x's RateLimitCards): Claude's and Codex's windows from the CLIs' saved readings,
// and Antigravity's Gemini quota, with why a reading is old or missing. Its refresh loop is usage-session.ts.
import { AntigravityQuota } from "./AntigravityQuota";
import { QuotaCard } from "./QuotaCard";
import type { UsageView } from "../../../../Web/host/src/api";
import { asOf, staleSince } from "./usage-text";
import { useUsageRefresh, type UsageSource } from "./usage-session";

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

export function QuickUsage({ source }: { source: UsageSource }) {
  const {usage, now, failed, loading, retry} = useUsageRefresh(source);

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
    <div className={codex.fiveHour ? "quick-usage-cards" : "quick-usage-cards single"}>
      {codex.fiveHour && <QuotaCard engine="Codex" title="5 hours" window={codex.fiveHour} now={now} lastKnown={!!codexProblem} />}
      <QuotaCard engine="Codex" title="Week" window={codex.week} now={now} lastKnown={!!codexProblem} weekly />
    </div>
    {codexProblem && <p className="quick-usage-note" role="status">Codex: {codexProblem}.</p>}
    {since(codex)}
    <h3>Antigravity</h3>
    <AntigravityQuota quota={usage?.antigravity} now={now} loading={loading} failed={failed} onRetry={retry} />
  </section>;
}
