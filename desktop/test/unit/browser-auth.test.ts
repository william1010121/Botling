// Sign-ins in the in-app browser pane (2026-11-10): the pane's user agent is plain Chrome's (Google refuses one naming
// Electron), and a sign-in popup stays a popup of its page (it reports back to window.opener) while target=_blank
// still opens a tab.
import { describe, expect, it } from "vitest";
import { paneUserAgent, popupWay } from "../../src/browser-auth";

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
