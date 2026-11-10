// User-agent client hints for the in-app browser pane (2026-11-10). The pane's session sends plain Chrome's user
// agent (browser-auth.ts), but Electron never adds Chrome's Sec-CH-UA* request headers, while the page still sees
// navigator.userAgentData. A browser that says "Chrome/152" in User-Agent yet sends no Sec-CH-UA on https looks
// like no real Chrome, which Cloudflare's human check ("Verify you are human", Turnstile) holds against it; the user
// saw it never get through on claude.ai.
//
// So the session adds the headers Chrome would send, with exactly the brands the page's navigator.userAgentData
// reports (Chromium's own list for this major version, generated the way Chromium does it with no product brand):
// the low-entropy three on every secure request, the high-entropy ones only to an origin that asked with Accept-CH.
// Nothing is solved or faked beyond that: the human still clicks the check.

export interface Brand { brand: string; version: string }

export interface HintFacts {
  /** Chrome's full version, process.versions.chrome (e.g. 152.0.7977.167). */
  chrome: string;
  /** process.platform. */
  platform: string;
  /** process.arch. */
  arch: string;
  /** process.getSystemVersion() (e.g. 26.3.0). */
  systemVersion: string;
}

const GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
const GREASE_VERSIONS = ["8", "99", "24"];

/** Chromium's brand list with no product brand (what Electron's navigator.userAgentData reports). */
export function chromiumBrands(chrome: string, full = false): Brand[] {
  const major = Number.parseInt(chrome, 10);
  const seed = Number.isFinite(major) && major > 0 ? major : 0;
  const grease: Brand = {
    brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`,
    version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length] + (full ? ".0.0.0" : ""),
  };
  const chromium: Brand = { brand: "Chromium", version: full ? chrome : String(seed) };
  const list: Brand[] = [];
  list[seed % 2] = grease;
  list[(seed + 1) % 2] = chromium;
  return list;
}

/** A structured-header list of brands, as Sec-CH-UA writes it. */
export function brandHeader(brands: Brand[]): string {
  return brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");
}

const PLATFORM: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" };
const ARCH: Record<string, string> = { arm64: "arm", arm: "arm", x64: "x86", ia32: "x86" };

function sfString(value: string): string { return `"${value.replace(/[\\"]/g, "\\$&")}"`; }

function platformVersion(version: string): string {
  const parts = version.split(".").filter((part) => /^\d+$/.test(part)).slice(0, 3);
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

/** Every UA client hint header Chrome can send, by lowercase name. */
export function allHints(facts: HintFacts): Record<string, string> {
  return {
    "sec-ch-ua": brandHeader(chromiumBrands(facts.chrome)),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": sfString(PLATFORM[facts.platform] ?? "Unknown"),
    "sec-ch-ua-arch": sfString(ARCH[facts.arch] ?? ""),
    "sec-ch-ua-bitness": sfString(facts.arch === "ia32" || facts.arch === "arm" ? "32" : "64"),
    "sec-ch-ua-full-version": sfString(facts.chrome),
    "sec-ch-ua-full-version-list": brandHeader(chromiumBrands(facts.chrome, true)),
    "sec-ch-ua-model": sfString(""),
    "sec-ch-ua-platform-version": sfString(platformVersion(facts.systemVersion)),
    "sec-ch-ua-wow64": "?0",
    "sec-ch-ua-form-factors": sfString("Desktop"),
  };
}

const LOW_ENTROPY = ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"];

/** The UA hints an Accept-CH (or Critical-CH) response header asks for, lowercase. */
export function acceptedHints(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(",") : value ?? "";
  return text.split(",").map((part) => part.trim().toLowerCase()).filter((name) => name.startsWith("sec-ch-ua"));
}

/** A potentially trustworthy URL (https, wss, or localhost over http): where Chrome sends client hints. */
export function isSecureUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "wss:") return true;
    return (u.protocol === "http:" || u.protocol === "ws:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch { return false; }
}

/** The request headers with Chrome's client hints for `url` set (any other Sec-CH-UA* the request carried replaced). */
export function withHints(url: string, headers: Record<string, string>, facts: HintFacts, asked: ReadonlySet<string> = new Set()): Record<string, string> {
  // Chrome writes the hints first, before Upgrade-Insecure-Requests and User-Agent; header order is part of what a
  // site sees, so they go first here too.
  const out: Record<string, string> = {};
  if (isSecureUrl(url)) {
    const hints = allHints(facts);
    for (const name of LOW_ENTROPY) out[name] = hints[name];
    for (const name of Object.keys(hints)) if (asked.has(name) && !(name in out)) out[name] = hints[name];
  }
  for (const [name, value] of Object.entries(headers)) if (!name.toLowerCase().startsWith("sec-ch-ua")) out[name] = value;
  return out;
}

/** Remembers which high-entropy hints each origin asked for (Accept-CH), for the session's lifetime. */
export class HintAsks {
  private readonly byOrigin = new Map<string, Set<string>>();
  private static readonly MAX = 500;

  record(url: string, responseHeaders: Record<string, string | string[]> | undefined): void {
    if (!responseHeaders || !isSecureUrl(url)) return;
    let names: string[] = [];
    for (const [name, value] of Object.entries(responseHeaders)) {
      const lower = name.toLowerCase();
      if (lower === "accept-ch" || lower === "critical-ch") names = names.concat(acceptedHints(value));
    }
    if (!names.length) return;
    const origin = new URL(url).origin;
    const set = this.byOrigin.get(origin) ?? new Set<string>();
    for (const name of names) set.add(name);
    this.byOrigin.delete(origin);
    this.byOrigin.set(origin, set);
    if (this.byOrigin.size > HintAsks.MAX) this.byOrigin.delete(this.byOrigin.keys().next().value as string);
  }

  for(url: string): ReadonlySet<string> {
    try { return this.byOrigin.get(new URL(url).origin) ?? new Set(); } catch { return new Set(); }
  }
}

/** The Accept-Language list from the languages the page sees (navigator.languages): setUserAgent adds the q values. */
export function acceptLanguages(languages: string[]): string {
  return languages.filter((lang) => /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(lang)).join(",");
}
