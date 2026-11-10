// Sign-ins in the in-app browser pane (2026-11-10): the two rules browser-host.ts applies so a site's sign-in works
// there as it does in Chrome.
//
// - The user agent: Electron's default names the app and "Electron/x", and Google's sign-in (and so "Continue with
//   Google" on claude.ai and elsewhere) refuses embedded browsers it recognizes that way ("This browser or app may
//   not be secure"). The pane's session sends plain Chrome's instead, in Chrome's reduced form (Chrome/<major>.0.0.0).
// - Popups: a sign-in popup (window.open with features: Google, Apple, Microsoft, …) reports back to its opener via
//   window.opener / postMessage, so it must stay a real popup of that page (same session, same safety settings), not
//   a new tab with no opener. A plain target=_blank link or window.open without features still becomes a tab.

/** Plain Chrome's user agent for the platform and Chrome major version of Electron's own `fallback`. */
export function paneUserAgent(fallback: string): string {
  const chrome = /\bChrome\/(\d+)/.exec(fallback)?.[1];
  const head = /^Mozilla\/5\.0 \([^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)/.exec(fallback)?.[0];
  if (!chrome || !head) return fallback.replace(/\s+Electron\/\S+/g, "");
  return `${head} Chrome/${chrome}.0.0.0 Safari/537.36`;
}

/** What a page's window.open / target=_blank becomes: a popup window of the page, a new tab, or nothing. */
export type PopupWay = "popup" | "tab" | "refuse";

export function popupWay(url: string, disposition: string): PopupWay {
  if (!isHttp(url) && url !== "about:blank") return "refuse";
  if (disposition === "new-window") return "popup";
  return url === "about:blank" ? "refuse" : "tab";
}

function isHttp(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
}
