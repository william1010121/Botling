// @vitest-environment jsdom
// The frame side: the source it reads through the program part, and the shipped ui.js (the built bundle, on Preact)
// drawing both views from what the program part answers.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { frameSource, TURN_POLL_MS } from "../src/source";

afterEach(() => vi.useRealTimers());

it("reads the usage through the program part, and tells when its turn counter moves (not for the first answer)", async () => {
  vi.useFakeTimers();
  let turns = 4;
  const calls: string[] = [];
  const ccb = { call: vi.fn(async (method: string) => { calls.push(method); return method === "turn" ? turns : { day: "d" }; }) };
  const source = frameSource(ccb);
  expect(await source.view()).toEqual({ day: "d" });
  const heard = vi.fn();
  const off = source.onTurnFinished(heard);
  await vi.advanceTimersByTimeAsync(0);
  expect(heard).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS);
  expect(heard).not.toHaveBeenCalled();
  turns = 5;
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS);
  expect(heard).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS);
  expect(heard).toHaveBeenCalledOnce();
  off();
  const asked = calls.length;
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS * 5);
  expect(calls.length).toBe(asked);
});

it("a failed ask of the counter is asked again, not an event", async () => {
  vi.useFakeTimers();
  let fail = true;
  const ccb = { call: vi.fn(async () => { if (fail) throw new Error("host busy"); return 1; }) };
  const heard = vi.fn();
  const off = frameSource(ccb).onTurnFinished(heard);
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS);
  fail = false;
  await vi.advanceTimersByTimeAsync(TURN_POLL_MS * 2);
  expect(heard).not.toHaveBeenCalled();
  off();
});

// out/ is built before the unit tests run (npm run build); esbuild itself cannot run inside jsdom.
const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.usage/ui.js"), "utf8");
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it("the shipped ui.js registers both views and draws the rings and Settings → Usage on Preact, with the tokens and its styles in the frame", async () => {
  const now = Date.now();
  const usage = {
    spendingStatus: "available", day: "2026-11-02", spent: 1.25, tokens: { input: 100, output: 200, cacheWrite: 300, cacheRead: 400 },
    byBot: [{ name: "Claude", spent: 1.25, tokens: 800 }], history: [],
    claude: { fiveHour: { used: .42, seen: now, resetsAt: now + 60_000 }, week: null }, codex: { fiveHour: null, week: { used: .31, seen: now, resetsAt: now + 86_400_000 } },
  };
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = { panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } }, call: async (method: string) => (method === "turn" ? 0 : usage) };
  const url = `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`;
  const module = await import(/* @vite-ignore */ url);
  module.activate(ccb);
  expect([...views.keys()]).toEqual(["botling.usage.quota", "botling.usage.settings"]);

  const rings = document.createElement("div"); document.body.append(rings);
  const stop = views.get("botling.usage.quota")!(rings);
  const labels = () => [...rings.querySelectorAll(".quick-usage-card")].filter((card) => !card.closest('[aria-label="Antigravity quota"]')).map((card) => card.getAttribute("aria-label"));
  await vi.waitFor(() => expect(labels()[0]).toContain("42% used"));
  expect(labels()).toEqual([expect.stringContaining("Claude 5 hours limit, 42% used, in 1m"), expect.stringContaining("Claude Week limit, unavailable"), expect.stringContaining("Codex Week limit, 31% used")]);
  const arc = rings.querySelector("svg circle[pathLength]") as SVGElement;
  expect(arc.style.strokeDasharray).toBe("0.42 1");
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  expect(document.head.querySelector("style")?.textContent).toContain(".quick-usage-card");
  (stop as () => void)();
  expect(document.head.querySelector("style")).toBeNull();

  const page = document.createElement("div"); document.body.append(page);
  views.get("botling.usage.settings")!(page);
  await vi.waitFor(() => expect(page.querySelector('[aria-label="Usage today"]')).not.toBeNull());
  expect(page.querySelector('[aria-label="Usage today"]')!.textContent).toContain("$1.25");
  expect(page.querySelector('[aria-label="Claude limits"]')!.textContent).toContain("5 hours 42%");
  expect(page.querySelector('[aria-label="By bot"]')!.textContent).toMatch(/Claude\s*800 tokens\s*\$1.25/);
});
