// Sign-ins in the in-app browser pane (2026-11-10): the two rules browser-host.ts applies so a site's sign-in works
// there as it does in Chrome.
//
// - The user agent: Electron's default names the app and "Electron/x", and Google's sign-in (and so "Continue with
//   Google" on claude.ai and elsewhere) refuses embedded browsers it recognizes that way ("This browser or app may
//   not be secure"). The pane's session sends plain Chrome's instead, in Chrome's reduced form (Chrome/<major>.0.0.0).
// - Popups: a sign-in popup (window.open with features: Google, Apple, Microsoft, …) reports back to its opener via
//   window.opener / postMessage, so it must stay a real popup of that page (same session, same safety settings), not
//   a new tab with no opener. A plain target=_blank link or window.open without features still becomes a tab.
// - The capture (2026-11-15): a tab has the DevTools protocol attached (the background network capture), a popup does
//   not, and Google refuses sign-in in a DevTools-controlled browser: GitHub's "Continue with Google" in a tab got "This
//   browser or app may not be secure" while claude.ai's Google popup signed in. So a tab drops its capture while its
//   top frame is on Google's sign-in pages and takes it up again when the page leaves (those requests are not captured).

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

/** Google's sign-in pages: accounts.google.com, the country hosts and accounts.youtube.com it sets cookies through. */
export function isSignInPage(url: string): boolean {
  let host: string;
  try { const u = new URL(url); if (u.protocol !== "https:" && u.protocol !== "http:") return false; host = u.hostname.toLowerCase(); } catch { return false; }
  return host === "accounts.youtube.com" || /^accounts\.google\.(?:com?\.)?[a-z]{2,3}$/.test(host);
}

/** A tab's DevTools protocol client, as the capture sees it. */
export interface Debuggee { isAttached(): boolean; attach(): void; detach(): void }

/** Attaches or detaches a tab's capture for the page its top frame is going to; whether it is attached now. */
export function captureFor(url: string, debuggee: Debuggee): boolean {
  const want = !isSignInPage(url);
  if (want !== debuggee.isAttached()) {
    if (want) debuggee.attach(); else debuggee.detach();
  }
  return debuggee.isAttached();
}

function isHttp(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
}
