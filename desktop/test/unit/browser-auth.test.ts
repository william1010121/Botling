// Sign-ins in the in-app browser pane (2026-11-10): the pane's user agent is plain Chrome's (Google refuses one naming
// Electron), and a sign-in popup stays a popup of its page (it reports back to window.opener) while target=_blank
// still opens a tab.
import { describe, expect, it } from "vitest";
import { captureFor, followNavigation, isSignInPage, paneUserAgent, popupWay, type Debuggee } from "../../src/browser-auth";

describe("pane user agent", () => {
  it("drops the app name and Electron, keeping the platform and Chrome's major version", () => {
    const electron = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) botling-desktop/2.4.0 Chrome/146.0.7680.65 Electron/44.9.3 Safari/537.36";
    expect(paneUserAgent(electron)).toBe("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36");
  });
  it("keeps another platform's part", () => {
    const ua = paneUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Botling 2/2.4.0 Chrome/146.0.1.2 Electron/44.9.3 Safari/537.36");
    expect(ua).toBe("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36");
  });
  it("still drops Electron from a user agent of another shape", () => {
    expect(paneUserAgent("Something Chrome/146 Electron/44.9.3 Safari/537.36")).not.toMatch(/Electron/);
  });
});

describe("popup way", () => {
  it("a window.open with features (a sign-in popup) stays a popup of its page", () => {
    expect(popupWay("https://accounts.google.com/o/oauth2/v2/auth?x=1", "new-window")).toBe("popup");
    expect(popupWay("about:blank", "new-window")).toBe("popup");
  });
  it("target=_blank and window.open without features open a tab", () => {
    expect(popupWay("https://example.com/", "foreground-tab")).toBe("tab");
    expect(popupWay("https://example.com/", "background-tab")).toBe("tab");
    expect(popupWay("https://example.com/", "default")).toBe("tab");
  });
  it("refuses what is not a web page", () => {
    expect(popupWay("file:///etc/passwd", "new-window")).toBe("refuse");
    expect(popupWay("javascript:alert(1)", "foreground-tab")).toBe("refuse");
    expect(popupWay("about:blank", "foreground-tab")).toBe("refuse");
  });
});

// 2026-11-15: Google refused GitHub's "Continue with Google" in a pane tab ("This browser or app may not be secure")
// while claude.ai's Google popup had signed in. A tab has the DevTools protocol attached for the network capture, a popup
// does not; Google refuses sign-in in a DevTools-controlled browser, so a tab drops the capture on Google's sign-in pages.
describe("sign-in pages", () => {
  it("are Google's account hosts, the country ones and YouTube's it redirects through", () => {
    for (const url of [
      "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      "https://accounts.google.com.tw/accounts/SetSID",
      "https://accounts.google.co.uk/accounts/SetSID",
      "https://accounts.google.de/accounts/SetSID",
      "https://accounts.youtube.com/accounts/SetSID",
      "https://ACCOUNTS.Google.com/",
    ]) expect(isSignInPage(url), url).toBe(true);
  });
  it("are nothing else", () => {
    for (const url of [
      "https://github.com/login",
      "https://www.google.com/search?q=accounts.google.com",
      "https://mail.google.com/",
      "https://accounts.google.evil.com/",
      "https://accounts.google.com.evil.com/",
      "https://evil.com/accounts.google.com",
      "http://accounts.google.com.example/",
      // Three-letter gTLDs anyone can register under (com.xyz, co.xyz, google.top): not Google's country hosts.
      "https://accounts.google.com.xyz/",
      "https://accounts.google.co.xyz/",
      "https://accounts.google.top/",
      "https://accounts.google.com./",
      "about:blank",
      "not a url",
    ]) expect(isSignInPage(url), url).toBe(false);
  });
});

describe("a tab's capture around sign-in pages", () => {
  function fake(attached = true) {
    const calls: string[] = [];
    let on = attached;
    const debuggee: Debuggee = {
      isAttached: () => on,
      attach: () => { calls.push("attach"); on = true; },
      detach: () => { calls.push("detach"); on = false; },
    };
    return { debuggee, calls };
  }
  it("detaches when the top frame goes to Google's sign-in", () => {
    const { debuggee, calls } = fake();
    expect(captureFor("https://accounts.google.com/v3/signin/identifier", debuggee)).toBe(false);
    expect(calls).toEqual(["detach"]);
  });
  it("stays detached through the sign-in's own redirects and attaches again when it leaves", () => {
    const { debuggee, calls } = fake(false);
    expect(captureFor("https://accounts.google.com/signin/oauth/consent", debuggee)).toBe(false);
    expect(captureFor("https://accounts.youtube.com/accounts/SetSID", debuggee)).toBe(false);
    expect(calls).toEqual([]);
    expect(captureFor("https://github.com/sessions/social/google/callback?code=x", debuggee)).toBe(true);
    expect(calls).toEqual(["attach"]);
  });
  it("leaves an attached tab alone on other pages", () => {
    const { debuggee, calls } = fake();
    expect(captureFor("https://github.com/login", debuggee)).toBe(true);
    expect(captureFor("about:blank", debuggee)).toBe(true);
    expect(calls).toEqual([]);
  });
  it("moves only on a new document in the top frame", () => {
    const { debuggee, calls } = fake();
    followNavigation({ url: "https://accounts.google.com/gsi/iframe/select", isMainFrame: false }, debuggee);
    followNavigation({ url: "https://accounts.google.com/#x", isMainFrame: true, isSameDocument: true }, debuggee);
    expect(calls).toEqual([]);
    followNavigation({ url: "https://accounts.google.com/v3/signin/identifier", isMainFrame: true, isSameDocument: false }, debuggee);
    expect(calls).toEqual(["detach"]);
  });
});
