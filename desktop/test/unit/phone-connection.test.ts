// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { RENDERER_COMMANDS, MAIN_COMMANDS, parseInbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { MobileDesk } from "../../src/mobile-bridge/desk";
import { PairingStore, type Route } from "../../src/mobile-bridge/pairing";
import { PhoneSettings } from "../../src/renderer/PhoneSettings";
import { mobileWords } from "../../src/renderer/mobile-text";
import type { Client } from "../../src/renderer/client";
import { tempDir } from "../helpers";

const ROUTES: Route[] = [{ kind: "tunnel", origin: "https://botling-bridge.example" }, { kind: "lan", origin: "https://botling.home.arpa" }];
const DEVICE = "d".repeat(22);
const open = (dataDir: string) => new Core({ dataDir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
  routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });

describe("phone connection commands", () => {
  it("are renderer-only commands that the core answers, never phone commands", () => {
    for (const type of ["mobile.view", "mobile.pair", "mobile.revoke"] as const) { expect(RENDERER_COMMANDS.has(type)).toBe(true); expect(MAIN_COMMANDS.has(type)).toBe(false); }
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "mobile.pair", botIds: [MAIN_BOT_ID], extra: 1 } }).ok).toBe(false);
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "mobile.pair", botIds: [] } }).ok).toBe(false);
    expect(parseInbound({ v: 10, id: "a", cmd: { type: "mobile.revoke", deviceId: "x" } }).ok).toBe(true);
  });
  it("are off until the bridge is configured, then pair, list and revoke through the core", async () => {
    const dir = tempDir("phone-core"), core: any = open(dir);
    try {
      core.activated = true;
      const run = (cmd: any) => core.handle(cmd, new AbortController().signal);
      expect(await run({ type: "mobile.view" })).toEqual({ enabled: false, routes: [], devices: [] });
      await expect(run({ type: "mobile.pair", botIds: [MAIN_BOT_ID] })).rejects.toThrow(/not set up/);
      const pairing = new PairingStore(join(tempDir("phone-pair")), Date.now, ROUTES);
      core.attachMobile(new MobileDesk(pairing, ROUTES));
      await expect(run({ type: "mobile.pair", botIds: ["no-such-bot"] })).rejects.toThrow(/Unknown bot/);
      const offer = await run({ type: "mobile.pair", botIds: [MAIN_BOT_ID], route: 1 });
      expect(offer.url.startsWith("https://botling.home.arpa/mobile/#pair=")).toBe(true);
      const secret = new URL(offer.url).hash.match(/pair=([^&]+)/)![1];
      expect(pairing.redeem(secret, DEVICE, "iPhone").ok).toBe(true);
      const view = await run({ type: "mobile.view" });
      expect(view.devices).toMatchObject([{ id: DEVICE, label: "iPhone", botIds: [MAIN_BOT_ID] }]);
      expect(JSON.stringify(view)).not.toContain(secret);
      expect((await run({ type: "mobile.revoke", deviceId: DEVICE })).devices).toEqual([]);
    } finally { await core.shutdown?.(); }
  });
});

describe("Settings > Phone", () => {
  const bots = [{ id: MAIN_BOT_ID, name: "Main", role: "main" }] as any;
  async function mount(request: (cmd: any) => Promise<any>, lang: string | null = "en") {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(PhoneSettings, { client: { request } as unknown as Client, bots, lang })));
    return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
  }
  const click = async (el: Element | undefined) => { await act(async () => (el as HTMLElement).click()); };
  const button = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);

  it("says so when the phone connection is not set up", async () => {
    const m = await mount(async () => ({ enabled: false, routes: [], devices: [] }));
    try { expect(m.host.textContent).toContain(mobileWords("en").off); expect(m.host.querySelector("button")).toBeNull(); } finally { await m.done(); }
  });
  it("needs a bot chosen, shows a QR for the one-time link, hides it on request, lists routes in order, and asks before revoking", async () => {
    const calls: any[] = []; let devices: any[] = [{ id: DEVICE, label: "iPhone", pairedAt: Date.UTC(2026, 9, 30), expiresAt: Date.UTC(2026, 10, 29), botIds: [MAIN_BOT_ID] }];
    const link = "https://botling-bridge.example/mobile/#pair=" + "S".repeat(43) + "&core=" + "a".repeat(32);
    const m = await mount(async (cmd) => {
      calls.push(cmd);
      if (cmd.type === "mobile.view") return { enabled: true, routes: ROUTES, devices };
      if (cmd.type === "mobile.pair") return { url: link, expiresAt: Date.now() + 300_000, route: ROUTES[0] };
      if (cmd.type === "mobile.revoke") { devices = []; return { enabled: true, routes: ROUTES, devices }; }
    });
    try {
      const create = button(m.host, "Create pairing code") as HTMLButtonElement;
      expect(create.disabled).toBe(true);
      const labels = [...m.host.querySelectorAll(".settings-hint")].map((e) => e.textContent ?? "");
      expect(labels.findIndex((t) => t.includes("botling-bridge.example"))).toBeLessThan(labels.findIndex((t) => t.includes("home.arpa")));
      await click(m.host.querySelector('input[type="checkbox"]')!);
      expect((button(m.host, "Create pairing code") as HTMLButtonElement).disabled).toBe(false);
      await click(button(m.host, "Create pairing code"));
      expect(calls.find((c) => c.type === "mobile.pair")).toEqual({ type: "mobile.pair", botIds: [MAIN_BOT_ID], route: 0 });
      expect(m.host.querySelector("svg.qr-code path")?.getAttribute("d")).toBeTruthy();
      expect(m.host.textContent).not.toContain("S".repeat(43)); // shown as a picture, not as text
      await click(button(m.host, "Hide code"));
      expect(m.host.querySelector("svg.qr-code")).toBeNull();
      await click(button(m.host, "Revoke iPhone"));
      expect(calls.some((c) => c.type === "mobile.revoke")).toBe(false); // asks first
      expect(m.host.querySelector('[role="alert"]')?.textContent).toContain("iPhone");
      await click([...m.host.querySelectorAll("button")].find((b) => b.textContent === "Revoke"));
      expect(calls.find((c) => c.type === "mobile.revoke")).toEqual({ type: "mobile.revoke", deviceId: DEVICE });
      expect(m.host.textContent).toContain("No phones are paired.");
    } finally { await m.done(); }
  });
  it("speaks Traditional Chinese", async () => {
    const m = await mount(async () => ({ enabled: true, routes: ROUTES, devices: [] }), "zh-Hant");
    try { expect(m.host.textContent).toContain("建立配對代碼"); expect(m.host.textContent).toContain("沒有已配對的手機。"); } finally { await m.done(); }
  });
});
