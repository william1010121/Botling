// @vitest-environment jsdom
// The frame side: what the shipped ui.js (the built bundle, on Preact) draws from what the program part answers, and the
// words and buttons each state of a routine has.
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { cadence, distance, groupOf, nextRun, operationsFor, standing, summary, zoneName, type RoutineLike } from "../src/routines-text";
import { frameSource } from "../src/source";

it("a routine's buttons follow its state: Pause while it will run, Resume while paused, Cancel until it is over", () => {
  expect(operationsFor("pending")).toEqual(["pause", "cancel"]);
  expect(operationsFor("enabled")).toEqual(["pause", "cancel"]);
  expect(operationsFor("due")).toEqual(["pause", "cancel"]);
  expect(operationsFor("paused")).toEqual(["resume", "cancel"]);
  for (const over of ["fired", "cancelled", "delivery_uncertain"]) expect(operationsFor(over)).toEqual([]);
});

it("says when a routine runs: the app's phrase or a cron line in words, a zone other than the system's, how far the next run is", () => {
  const base = { id: "R", kind: "recurring" as const, task: "t", title: "t", schedule: "Every weekday 09:00", cron: "0 9 * * 1-5", timezone: "Asia/Taipei", status: "pending", next: null };
  expect(cadence(base)).toBe("Weekdays 09:00");
  expect(zoneName(base)).toBe("Taipei");
  expect(zoneName({ ...base, timezone: "system_local" })).toBeNull();
  const phrase = { ...base, cron: null };
  expect(cadence({ ...phrase, schedule: "*/10 * * * *" })).toBe("Every 10 min");
  expect(cadence({ ...phrase, schedule: "5 4 3 * *" })).toBe("Monthly on day 3 04:05");
  expect(cadence({ ...phrase, schedule: "1 2 3 4 5" })).toBe("1 2 3 4 5");
  expect(cadence({ ...phrase, schedule: "Every day 08:15" })).toBe("Every day 08:15");
  expect(cadence({ ...base, kind: "once" })).toBe("One time");
  const now = Date.parse("2026-11-03T01:00:00.000Z");
  expect(distance(now + 6 * 60_000, now)).toBe("in 6 min");
  expect(distance(now - 4 * 60_000, now)).toBe("4 min ago");
  expect(distance(now + 21 * 3_600_000, now)).toBe("in 21 h");
  expect(nextRun(base, now)).toBeNull();
  expect(nextRun({ ...base, next: new Date(now + 3_600_000).toISOString() }, now)?.away).toBe("in 1 h");
});

it("groups a routine by where it stands, and names its standing", () => {
  const base = { id: "R", kind: "recurring" as const, task: "t", title: "t", schedule: "Every day 09:00", cron: null, timezone: "system_local", status: "pending", next: null };
  expect(groupOf(base)).toBe("active");
  expect(groupOf({ ...base, status: "paused" })).toBe("paused");
  expect(groupOf({ ...base, status: "fired" })).toBe("done");
  expect(groupOf({ ...base, status: "cancelled" })).toBe("done");
  expect(groupOf({ ...base, status: "delivery_uncertain" })).toBe("attention");
  expect(groupOf({ ...base, watch: { command: "c", state: "failing", lastRun: null, exit: 1, timedOut: false } })).toBe("attention");
  expect(standing({ ...base, status: "delivery_uncertain" }).word).toBe("Not confirmed");
  expect(standing(base)).toEqual({ word: "Scheduled", tone: "ok" });
});

it("reads and changes through the program part, for the bot of the frame", async () => {
  const call = vi.fn(async () => ({ routines: [], error: null }));
  const source = frameSource({ call }, "B1");
  await source.list();
  await source.change("resume", "R1");
  expect(call.mock.calls).toEqual([["list", { botId: "B1" }], ["change", { botId: "B1", operation: "resume", id: "R1" }]]);
});

// out/ is built before the unit tests run (npm run build); esbuild itself cannot run inside jsdom.
const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.routines/ui.js"), "utf8");
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it("the shipped ui.js registers the view and draws the list, pausing and a refused change, with the tokens and its styles in the frame", async () => {
  const routine = (id: string, status: string, more: object = {}) => ({ id, kind: "recurring", task: id, title: `Job ${id}`, schedule: "Every day 08:15", cron: "15 8 * * *", timezone: "system_local", status, next: null, ...more });
  let routines = [routine("A", "pending"), routine("B", "paused"), routine("C", "fired")];
  const calls: unknown[] = [];
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = {
    context: { botId: "B1" },
    panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } },
    call: async (method: string, params: { operation?: string; id?: string }) => {
      calls.push([method, params]);
      if (method === "change" && params.id === "B" && params.operation === "cancel") throw new Error("Not now");
      if (method === "change") routines = routines.map((entry) => (entry.id === params.id ? { ...entry, status: params.operation === "pause" ? "paused" : entry.status } : entry));
      return { routines, error: null };
    },
  };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  expect([...views.keys()]).toEqual(["botling.routines.panel"]);
  const root = document.createElement("div");
  document.body.append(root);
  const stop = views.get("botling.routines.panel")!(root);
  await vi.waitFor(() => expect(root.querySelectorAll("li")).toHaveLength(3));
  expect(calls[0]).toEqual(["list", { botId: "B1" }]);
  const rows = [...root.querySelectorAll("li")];
  expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["pending", "paused", "fired"]); // running, paused, finished
  expect(rows.map((row) => [...row.querySelectorAll("button")].map((button) => button.textContent))).toEqual([["Pause", "Cancel"], ["Resume", "Cancel"], []]);
  expect(rows[0]!.querySelector(".routine-cadence")!.textContent).toBe("Daily 08:15");
  // Every card has its last-result line, from the core's lastRun / lastResult
  expect(rows.map((row) => row.querySelector(".routine-result")?.textContent)).toEqual(["Not run yet", "Not run yet", "Not run yet"]);
  expect(rows[0]!.querySelector(".routine-state")!.textContent).toBe("Scheduled");
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  expect(document.head.querySelector("style")?.textContent).toContain(".routine-buttons");

  (rows[0]!.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(root.querySelector("li")!.getAttribute("data-status")).toBe("paused"));
  expect(calls.at(-1)).toEqual(["change", { botId: "B1", operation: "pause", id: "A" }]);

  // Cancel asks once more; "Yes, cancel" sends it. The question is looked for with getElementsByClassName: jsdom's selector engine
  // kept answering "none" to a `.routine-confirm` query that was first run before the question was drawn, though it was in the DOM.
  const jobB = () => [...root.querySelectorAll("li")].find((row) => row.querySelector(".routine-title")?.textContent === "Job B")!;
  (jobB().querySelector('button[data-op="cancel"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(root.getElementsByClassName("routine-confirm")).toHaveLength(1));
  expect(calls.at(-1)).toEqual(["change", { botId: "B1", operation: "pause", id: "A" }]);
  // Keep closes the question and sends nothing; asking again brings it back.
  const keep = [...root.getElementsByClassName("routine-confirm")[0]!.querySelectorAll("button")].find((button) => button.textContent === "Keep") as HTMLButtonElement;
  keep.click();
  await vi.waitFor(() => expect(root.getElementsByClassName("routine-confirm")).toHaveLength(0));
  expect(calls.at(-1)).toEqual(["change", { botId: "B1", operation: "pause", id: "A" }]);
  (jobB().querySelector('button[data-op="cancel"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(root.getElementsByClassName("routine-confirm")).toHaveLength(1));
  (root.getElementsByClassName("routine-confirm")[0]!.querySelector(".danger") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(root.querySelector(".routines-problem")?.textContent).toBe("Not now"));
  expect(root.querySelectorAll("li")).toHaveLength(3);

  (stop as () => void)();
  expect(document.head.querySelector("style")).toBeNull();
});

it("an empty list says so, and the core's own problem is shown above it", async () => {
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = { context: { botId: "B1" }, panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } }, call: async () => ({ routines: [], error: "routines.cron is unreadable" }) };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  const root = document.createElement("div");
  document.body.append(root);
  views.get("botling.routines.panel")!(root);
  await vi.waitFor(() => expect(root.querySelector(".routines-empty")?.textContent).toBe("No routines yet. Ask the bot to schedule one."));
  expect(root.querySelector(".routines-problem")?.textContent).toBe("routines.cron is unreadable");
});

it("a watch shows its command and how its last run went", async () => {
  const { watchResult } = await import("../src/routines-text");
  const base: RoutineLike = { kind: "legacy", schedule: "*/10 * * * *", cron: "*/10 * * * *", timezone: "system_local", status: "enabled", next: null };
  const now = Date.parse("2026-11-11T02:30:00.000Z");
  const ran = "2026-11-11T02:20:00.000Z";
  expect(watchResult(base, now)).toBeNull();
  expect(watchResult({ ...base, watch: { command: "./check.sh", state: "never", lastRun: null, exit: null, timedOut: false } }, now)).toEqual({ word: "Not run yet", detail: "", tone: "off" });
  expect(watchResult({ ...base, watch: { command: "./check.sh", state: "ok", lastRun: ran, exit: 0, timedOut: false } }, now)).toEqual({ word: "Last run OK", detail: "10 min ago", tone: "ok" });
  expect(watchResult({ ...base, watch: { command: "./check.sh", state: "failing", lastRun: ran, exit: 3, timedOut: false } }, now)).toEqual({ word: "Last run failed", detail: "exit 3 · 10 min ago", tone: "bad" });
  expect(watchResult({ ...base, watch: { command: "./check.sh", state: "failing", lastRun: ran, exit: null, timedOut: true } }, now)?.detail).toContain("timed out");
});

it("the one-line summary counts every group, and says need / needs by the count", () => {
  const base = { kind: "recurring" as const, schedule: "Every day 09:00", cron: null, timezone: "system_local", status: "pending", next: null };
  const failing = { command: "c", state: "failing" as const, lastRun: null, exit: 1, timedOut: false };
  expect(summary([])).toBe("");
  expect(summary([base, base, { ...base, status: "paused" }, { ...base, status: "fired" }, { ...base, status: "delivery_uncertain" }])).toBe("2 running · 1 paused · 1 needs a look · 1 finished");
  expect(summary([{ ...base, status: "paused" }, { ...base, status: "paused" }, { ...base, watch: failing }, { ...base, status: "delivery_uncertain" }])).toBe("2 paused · 2 need a look");
});

it("a double tap on a button sends the change once", async () => {
  const routine = { id: "A", kind: "recurring", task: "A", title: "Job A", schedule: "Every day 08:15", cron: "15 8 * * *", timezone: "system_local", status: "pending", next: null };
  const calls: string[] = [];
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = {
    context: { botId: "B1" },
    panels: { register: (id: string, fn: (root: HTMLElement) => void) => { views.set(id, fn); return () => {}; } },
    call: async (method: string) => { calls.push(method); return { routines: [routine], error: null }; },
  };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  const root = document.createElement("div");
  document.body.append(root);
  views.get("botling.routines.panel")!(root);
  await vi.waitFor(() => expect(root.querySelectorAll("li")).toHaveLength(1));
  const pause = root.querySelector('button[data-op="pause"]') as HTMLButtonElement;
  pause.click(); // two taps in one batch: the second sees the old state, only a ref stops it (L-007)
  pause.click();
  await vi.waitFor(() => expect(calls.filter((method) => method === "change").length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls.filter((method) => method === "change")).toHaveLength(1);
});
