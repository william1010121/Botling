// @vitest-environment jsdom
// Botling 3 Settings › Phone in the window (src/renderer/PhoneSettingsV3.tsx, shown by PhoneSettings when botlingd's
// view carries `v3`): one button makes the cluster (the recovery code is shown once in a dialog, never typed back),
// then a pairing code follows at once as a QR of the Botling 3 link, a phone's 6-digit code is compared and accepted or rejected once, paired phones
// are listed and revoked (after asking). The 2.x view (no `v3`) keeps its own screen. The phone page's sign-in words
// point at Settings › Phone, never at a command line.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { PhoneSettings } from "../../src/renderer/PhoneSettings";
import { mobileWords } from "../../src/renderer/mobile-text";
import type { Client } from "../../src/renderer/client";
import { NOT_A_PAIR_LINK, SIGNIN_LEAD } from "../../web-v3/shell/signin-text";

const DEVICE = "D".repeat(43);
const OFFER = "o".repeat(22);
const LINK = `https://relay.example/v3/#pair=${"e".repeat(560)}`;
const CODE = "ABCD-EFGH-JKLM-NPQR-STUV-WXYZ-23";

type V3 = { cluster: "none" | "confirming" | "ready"; relayFixed: boolean; offers: any[]; devices: any[] };
const viewOf = (v3: V3, relay = { url: "wss://relay.example/ws" as string | null, state: "online" }) => ({ enabled: false, routes: [], devices: [], relay, v3 });

async function mount(request: (cmd: any) => Promise<any>, lang: string | null = "en") {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(PhoneSettings, { client: { request } as unknown as Client, bots: [], lang })));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}
const click = async (el: Element | undefined | null) => { expect(el, "the element to click").toBeTruthy(); await act(async () => (el as HTMLElement).click()); };
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const settle = async (ms = 0) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const v3 = mobileWords("en").v3;

describe("Settings › Phone in Botling 3", () => {
  it("first pairing: one button makes the cluster, shows the recovery code once in a dialog (no typing back), then the QR", async () => {
    const calls: any[] = [];
    let cluster: V3["cluster"] = "none";
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      if (cmd.type === "mobile.cluster") { cluster = "ready"; return { ok: true, code: CODE }; }
      if (cmd.type === "mobile.pair") return { url: LINK, expiresAt: Date.now() + 300_000, route: { kind: "relay", origin: "https://relay.example" }, offer: OFFER };
      return viewOf({ cluster, relayFixed: false, offers: [], devices: [] });
    });
    try {
      expect(button(m.host, mobileWords("en").create)).toBeUndefined(); // no code before the cluster exists
      await click(button(m.host, v3.setup));
      expect(calls.filter((c) => c.type === "mobile.cluster")).toEqual([{ type: "mobile.cluster" }]);
      // The recovery code, once, in a dialog like an API key: copy it, say it is saved. Nothing to type back.
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
      expect(dialog?.textContent).toContain(CODE);
      expect(dialog.textContent).toContain(v3.codeNote);
      expect(dialog.querySelector("input")).toBeNull();
      expect(m.host.querySelector('input[type="text"]')).toBeNull();
      expect(button(dialog, v3.copyCode)).toBeTruthy();
      expect(calls.some((c) => c.type === "mobile.pair")).toBe(false);
      await click(button(dialog, v3.saved));
      await settle();
      expect(document.body.textContent).not.toContain(CODE); // shown once: gone once saved
      expect(calls.filter((c) => c.type === "mobile.pair")).toEqual([{ type: "mobile.pair" }]);
      // A Botling 3 link (about 600 bytes) still makes a QR picture, and the link is never shown as text.
      expect(m.host.querySelector("svg.qr-code path")?.getAttribute("d")).toBeTruthy();
      expect(m.host.textContent).not.toContain("e".repeat(40));
    } finally { await m.done(); }
  });

  it("shows the phone's 6-digit code to compare and sends one accept for a double click; reject sends accept: false", async () => {
    const calls: any[] = [];
    let offers: any[] = [];
    let release: (() => void) | null = null;
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      if (cmd.type === "mobile.pair") { offers = [{ offer: OFFER, state: "waiting", expiresAt: Date.now() + 300_000 }]; return { url: LINK, expiresAt: Date.now() + 300_000, route: { kind: "relay", origin: "https://relay.example" }, offer: OFFER }; }
      if (cmd.type === "mobile.confirm") {
        await new Promise<void>((resolve) => { release = resolve; });
        offers = [{ offer: OFFER, state: "paired", device: "iPhone", expiresAt: Date.now() + 300_000 }];
      }
      return viewOf({ cluster: "ready", relayFixed: false, offers, devices: [] });
    });
    try {
      await click(button(m.host, mobileWords("en").create));
      offers = [{ offer: OFFER, state: "compare", code: "042917", device: "iPhone", expiresAt: Date.now() + 300_000 }];
      await settle(1_200); // the window looks again while a code is showing
      expect(m.host.textContent).toContain("042 917");
      expect(m.host.textContent).toContain("iPhone");
      const accept = button(m.host, v3.accept)!;
      await act(async () => { accept.click(); accept.click(); });
      expect(calls.filter((c) => c.type === "mobile.confirm")).toEqual([{ type: "mobile.confirm", offer: OFFER, accept: true, code: "042917" }]);
      await act(async () => { release!(); });
      await settle();
      expect(m.host.textContent).toContain(v3.paired("iPhone"));
      expect(m.host.querySelector("svg.qr-code")).toBeNull();
    } finally { await m.done(); }

    const rejects: any[] = [];
    const r = await mount(async (cmd) => {
      rejects.push(cmd);
      if (cmd.type === "mobile.pair") return { url: LINK, expiresAt: Date.now() + 300_000, route: { kind: "relay", origin: "https://relay.example" }, offer: OFFER };
      const shown = rejects.some((c) => c.type === "mobile.pair");
      return viewOf({ cluster: "ready", relayFixed: false, offers: shown ? [{ offer: OFFER, state: "compare", code: "111222", device: "Phone", expiresAt: Date.now() + 300_000 }] : [], devices: [] });
    });
    try {
      await click(button(r.host, mobileWords("en").create));
      await settle(1_200);
      await click(button(r.host, v3.reject));
      expect(rejects.filter((c) => c.type === "mobile.confirm")).toEqual([{ type: "mobile.confirm", offer: OFFER, accept: false, code: "111222" }]);
    } finally { await r.done(); }
  });

  it("lists the paired phones and asks before revoking one; a relay fixed by the environment cannot be edited", async () => {
    const calls: any[] = [];
    let devices = [{ id: DEVICE, name: "iPhone", addedAt: Date.UTC(2026, 10, 1), scope: ["read", "reply", "approve", "manage"] }];
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      if (cmd.type === "mobile.revoke") devices = [];
      return viewOf({ cluster: "ready", relayFixed: true, offers: [], devices });
    });
    try {
      expect(m.host.textContent).toContain("iPhone");
      expect((m.host.querySelector('input[type="url"]') as HTMLInputElement).disabled).toBe(true);
      expect(m.host.textContent).toContain(v3.relayFixed);
      await click(button(m.host, `${mobileWords("en").revoke} iPhone`));
      expect(calls.some((c) => c.type === "mobile.revoke")).toBe(false); // asks first
      await click([...m.host.querySelectorAll("button")].find((b) => b.textContent === mobileWords("en").revokeYes));
      expect(calls.find((c) => c.type === "mobile.revoke")).toEqual({ type: "mobile.revoke", deviceId: DEVICE });
      expect(m.host.textContent).toContain(mobileWords("en").none);
    } finally { await m.done(); }
  });

  it("turns the relay on from the window and says it is connected, live", async () => {
    const calls: any[] = [];
    let relay = { url: null as string | null, state: "off" };
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      if (cmd.type === "mobile.relay") relay = { url: cmd.url, state: cmd.url ? "online" : "off" };
      return viewOf({ cluster: "ready", relayFixed: false, offers: [], devices: [] }, relay);
    });
    try {
      await type(m.host.querySelector('input[type="url"]') as HTMLInputElement, "wss://relay.example/ws");
      await click(button(m.host, mobileWords("en").relayOn));
      expect(calls.find((c) => c.type === "mobile.relay")).toEqual({ type: "mobile.relay", url: "wss://relay.example/ws" });
      expect(m.host.textContent).toContain(mobileWords("en").relayState.online);
    } finally { await m.done(); }
  });

  it("speaks Traditional Chinese", async () => {
    const m = await mount(async () => viewOf({ cluster: "none", relayFixed: false, offers: [], devices: [] }), "zh-Hant");
    try {
      expect(m.host.textContent).toContain(mobileWords("zh-Hant").v3.setup);
    } finally { await m.done(); }
  });

  it("leaves the 2.x screen as it was when the view has no v3 part", async () => {
    const m = await mount(async () => ({ enabled: false, routes: [], devices: [], relay: { url: null, state: "off" } }));
    try {
      expect(button(m.host, v3.setup)).toBeUndefined();
      expect(m.host.textContent).toContain(mobileWords("en").off);
      expect(m.host.textContent).not.toContain(v3.setupNote);
    } finally { await m.done(); }
  });
});

describe("the phone page's sign-in words", () => {
  it("send the person to Settings › Phone in Botling, never to a command line", () => {
    for (const text of [SIGNIN_LEAD, NOT_A_PAIR_LINK]) {
      expect(text).not.toMatch(/botlingd|run /i);
      expect(text).toContain("Settings › Phone");
    }
  });
});
