// The words around a subscription's limits (1.x's RateLimitText, RateLimits.staleSince, in English).
// Times are ms since 1970.
export interface LimitWindow { used: number; resetsAt: number | null; seen: number }
export interface Limits { fiveHour: LimitWindow | null; week: LimitWindow | null }

/** Readings older than this get an "as of" note (`RateLimits.staleAfter`, 10 min). */
export const STALE_AFTER_MS = 10 * 60_000;

export const hasReset = (window: LimitWindow, now: number) => window.resetsAt !== null && window.resetsAt <= now;
export const isEmpty = (limits: Limits) => !limits.fiveHour && !limits.week;

/** "42%", or "–" once the window has started over (what is used since is not known yet). */
export function percent(window: LimitWindow, now: number): string {
  // (used is 0…1: Math.round and Swift's half-away-from-zero agree.)
  return hasReset(window, now) ? "–" : `${Math.round(window.used * 100)}%`;
}

/** The 5-hour window: "in 2h 13m", "in 8m". */
export function countdown(window: LimitWindow, now: number): string {
  if (window.resetsAt === null) return "";
  if (window.resetsAt <= now) return "reset";
  const minutes = Math.max(1, Math.ceil((window.resetsAt - now) / 60_000));
  return minutes >= 60 ? `in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `in ${minutes}m`;
}

/** The weekly window: "Thu 9:00 PM" (a time today: "9:00 PM"). */
export function resetDay(window: LimitWindow, now: number, locale?: string, timeZone?: string): string {
  if (window.resetsAt === null) return "";
  if (window.resetsAt <= now) return "reset";
  const day = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const sameDay = day(window.resetsAt) === day(now);
  const parts = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit", ...(sameDay ? {} : { weekday: "short" }) }).formatToParts(new Date(window.resetsAt));
  // Foundation puts a narrow no-break space before AM/PM (Chromium's ICU went back to a plain one), as specs.ts's shortTime.
  return parts.map((part, index) => (part.type === "literal" && parts[index + 1]?.type === "dayPeriod" && part.value === " " ? "\u202f" : part.value)).join("");
}

/** "as of 25 min ago", "as of 3 h ago", "as of 2 days ago". */
export function asOf(seen: number, now: number): string {
  const minutes = Math.max(0, Math.trunc((now - seen) / 60_000));
  if (minutes < 60) return `as of ${minutes} min ago`;
  if (minutes < 48 * 60) return `as of ${Math.trunc(minutes / 60)} h ago`;
  return `as of ${Math.trunc(minutes / (24 * 60))} days ago`;
}

/** When the older shown reading came in, if that is long enough ago to say so (`staleSince`). */
export function staleSince(limits: Limits, now: number): number | null {
  const seen = [limits.fiveHour, limits.week].flatMap((window) => (window ? [window.seen] : []));
  if (!seen.length) return null;
  const oldest = Math.min(...seen);
  return now - oldest >= STALE_AFTER_MS ? oldest : null;
}

/**
 * `String(format: "%.Nf", value)`: the exact binary value rounded to `digits` places, a tie to the even digit
 * (JavaScript's toFixed takes the larger one: 1.25 → "1.3" where printf says "1.2").
 */
export function printfFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0;
  // toFixed(100) is the exact decimal expansion of a double this size (its binary fraction ends well within it).
  const exact = Math.abs(value).toFixed(100);
  const [whole, fraction] = exact.split(".") as [string, string];
  const kept = fraction.slice(0, digits);
  const rest = fraction.slice(digits);
  let digitsText = whole + kept;
  const first = rest[0] ?? "0";
  const tail = rest.slice(1);
  const last = Number(digitsText[digitsText.length - 1] ?? "0");
  const up = first > "5" || (first === "5" && (/[1-9]/.test(tail) || last % 2 === 1));
  if (up) {
    const chars = digitsText.split("");
    let i = chars.length - 1;
    while (i >= 0) {
      if (chars[i] === "9") { chars[i] = "0"; i--; continue; }
      chars[i] = String(Number(chars[i]) + 1);
      break;
    }
    digitsText = (i < 0 ? "1" : "") + chars.join("");
  }
  const intPart = digitsText.slice(0, digitsText.length - digits) || "0";
  const text = digits > 0 ? `${intPart}.${digitsText.slice(digitsText.length - digits)}` : intPart;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/** "$1.23" (`Workspace.dollars`). */
export const dollars = (amount: number) => `$${printfFixed(amount, 2)}`;

/** "1.2M", "34.5K", "812" (`Workspace.tokenCount`). */
export function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${printfFixed(count / 1_000_000, 1)}M`;
  if (count >= 1_000) return `${printfFixed(count / 1_000, 1)}K`;
  return String(count);
}
