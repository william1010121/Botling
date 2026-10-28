// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, UsageView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { SidebarSettings } from "../../src/renderer/SidebarSettings";

const now = new Date(2026, 9, 26, 12).getTime();
const limits = (): UsageView => ({
  spendingStatus: "missing", day: "2026-10-26", spent: 0,
  tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, byBot: [], history: [],
  claude: { fiveHour: { used: .42, seen: now, resetsAt: now + 60_000 }, week: { used: .18, seen: now, resetsAt: now + 3 * 86400_000 } },
  codex: { fiveHour: { used: .99, seen: now, resetsAt: now + 3600_000 }, week: { used: .31, seen: now, resetsAt: now + 5 * 86400_000 } },
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  vi.useRealTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(request = vi.fn(async () => limits())) {
  let listener: ((event: EventEnvelope) => void) | null = null;
  const off = vi.fn();
  const client = { request, onEvent: vi.fn(fn => { listener = fn; return off; }) } as unknown as Client;
  await act(async () => root.render(createElement(SidebarSettings, {
    client, settings: null, plugins: null, settingsOpen: false, onOpen() {},
  })));
  const toggle = async () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!.click());
  const finished = async () => act(async () => listener?.({ event: { type: "turn.finished" } } as EventEnvelope));
  const cards = () => [...host.querySelectorAll<HTMLElement>(".quick-usage-card")];
  return { toggle, finished, cards, request, off };
}

describe("quota readings in the production Quick settings popup", () => {
  it("loads on open and shows exactly Claude 5-hour/week and Codex week, independent of spending", async () => {
    const ui = await mount();
    expect(ui.request).not.toHaveBeenCalled();
    await ui.toggle();
    expect(ui.request).toHaveBeenCalledWith({ type: "usage.view" });
    expect(ui.cards().map(card => card.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("Claude 5 hours limit, 42% used, in 1m"),
      expect.stringContaining("Claude Week limit, 18% used"),
      expect.stringContaining("Codex Week limit, 31% used"),
    ]);
    expect(host.textContent).toContain("Develop Botling itself");
    expect(host.textContent).toContain("Usage by bot");
    expect(host.textContent).not.toContain("99%");
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Last-known");
  });

  it("keeps missing windows unavailable and distinguishes an actually reported zero", async () => {
    const value = limits(); value.claude = { fiveHour: null, week: null };
    value.codex.week = { used: 0, seen: now, resetsAt: null };
    const ui = await mount(vi.fn(async () => value)); await ui.toggle();
    expect(ui.cards()[0].textContent).toContain("unavailable");
    expect(ui.cards()[1].textContent).toContain("unavailable");
    expect(ui.cards()[0].textContent).not.toContain("0%");
    expect(ui.cards()[2].getAttribute("aria-label")).toBe("Codex Week limit, 0% used");
  });

  it("updates on a completed turn, advances reset/stale text each minute, and stops requesting when closed", async () => {
    const value = limits();
    const ui = await mount(vi.fn(async () => structuredClone(value))); await ui.toggle();
    value.codex.week!.used = .81;
    await ui.finished();
    expect(ui.cards()[2].textContent).toContain("81%");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(ui.cards()[0].textContent).toContain("–5 hoursreset");
    expect(ui.cards()[0].textContent).not.toContain("0%");
    await act(async () => vi.advanceTimersByTime(9 * 60_000));
    expect(host.textContent).toContain("as of 10 min ago");
    await ui.toggle(); expect(ui.off).toHaveBeenCalledOnce();
    const calls = ui.request.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(ui.request).toHaveBeenCalledTimes(calls);
    await ui.toggle(); expect(ui.request).toHaveBeenCalledTimes(calls + 1);
  });

  it("shows failure as unavailable, retries, and retains the last reading during a later failure", async () => {
    const request = vi.fn(async () => limits()).mockRejectedValueOnce(new Error("offline"));
    const ui = await mount(request); await ui.toggle();
    expect(ui.cards()).toHaveLength(3);
    for (const card of ui.cards()) { expect(card.textContent).toContain("unavailable"); expect(card.textContent).not.toContain("0%"); }
    await act(async () => host.querySelector<HTMLButtonElement>(".quick-usage-note button")!.click());
    expect(ui.cards()[0].textContent).toContain("42%");
    request.mockRejectedValueOnce(new Error("offline")); await ui.finished();
    expect(host.textContent).toContain("Quota readings unavailable.");
    for (const card of ui.cards()) expect(card.getAttribute("aria-label")).toContain("Last-known");
    expect(host.textContent).toContain("Claude: quota refresh failed.");
    expect(host.textContent).toContain("Codex: quota refresh failed.");
    expect(ui.cards()[0].textContent).toContain("42%");
    await ui.finished();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Last-known");
  });

  it.each([
    ["auth_required", "sign-in required"],
    ["forbidden", "quota access denied"],
    ["timeout", "quota request timed out"],
    ["network_error", "quota network error"],
    ["invalid_response", "invalid quota response"],
    ["missing", "quota readings missing"],
    ["cli_unavailable", "CLI unavailable"],
  ] as const)("explains %s independently for each provider without adding retries", async (status, note) => {
    const value = limits();
    value.quotaStatus = { claude: status, codex: "available" };
    const ui = await mount(vi.fn(async () => structuredClone(value))); await ui.toggle();
    expect([...host.querySelectorAll('[role="status"]')].map(node => node.textContent)).toEqual([`Claude: ${note}.`]);
    expect(ui.cards()[0].getAttribute("aria-label")).toContain("42% used, Last-known");
    expect(ui.cards()[1].getAttribute("aria-label")).toContain("18% used, Last-known");
    expect(ui.cards()[2].getAttribute("aria-label")).not.toContain("Last-known");
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(ui.request).toHaveBeenCalledTimes(1);
    value.quotaStatus = { claude: "available", codex: status };
    await ui.finished();
    expect([...host.querySelectorAll('[role="status"]')].map(node => node.textContent)).toEqual([`Codex: ${note}.`]);
    expect(ui.cards()[0].getAttribute("aria-label")).not.toContain("Last-known");
    expect(ui.cards()[1].getAttribute("aria-label")).not.toContain("Last-known");
    expect(ui.cards()[2].getAttribute("aria-label")).toContain("31% used, Last-known");
    value.quotaStatus.codex = "available"; value.codex.week!.used = .52;
    await ui.finished();
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("Last-known");
    expect(ui.cards()[2].textContent).toContain("52%");
  });

  it("labels only retained windows, preserving missing versus measured zero on failure", async () => {
    const value = limits();
    value.quotaStatus = { claude: "auth_required", codex: "cli_unavailable" };
    value.claude = { fiveHour: null, week: { used: 0, seen: now, resetsAt: null } };
    value.codex.week = null;
    const ui = await mount(vi.fn(async () => value)); await ui.toggle();
    expect(ui.cards()).toHaveLength(3);
    for (const index of [0, 2]) {
      expect(ui.cards()[index].textContent).toContain("unavailable");
      expect(ui.cards()[index].textContent).not.toMatch(/0%|Last-known/);
    }
    expect(ui.cards()[1].getAttribute("aria-label")).toBe("Claude Week limit, 0% used, Last-known");
    expect(host.textContent).toContain("Claude: sign-in required.");
    expect(host.textContent).toContain("Codex: CLI unavailable.");
  });

  it("does not apply an outstanding request from a closed popup to the next opening", async () => {
    let resolve!: (value: UsageView) => void;
    const request = vi.fn(() => new Promise<UsageView>(done => { resolve = done; }));
    const ui = await mount(request); await ui.toggle();
    const previous = resolve; await ui.toggle(); await ui.toggle();
    await act(async () => previous(limits()));
    expect(ui.cards()[0].textContent).toContain("unavailable");
    const value = limits(); value.claude.fiveHour!.used = .56;
    await act(async () => resolve(value));
    expect(ui.cards()[0].textContent).toContain("56%");
  });
});
