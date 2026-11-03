// @vitest-environment jsdom
// The frame side: what the shipped ui.js (the built bundle, on Preact) draws from what the program part answers, and the
// words and buttons each state of a routine has.
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { operationsFor, whenLine } from "../src/routines-text";
import { frameSource } from "../src/source";

it("a routine's buttons follow its state: Pause while it will run, Resume while paused, Cancel until it is over", () => {
  expect(operationsFor("pending")).toEqual(["pause", "cancel"]);
  expect(operationsFor("enabled")).toEqual(["pause", "cancel"]);
  expect(operationsFor("due")).toEqual(["pause", "cancel"]);
  expect(operationsFor("paused")).toEqual(["resume", "cancel"]);
  for (const over of ["fired", "cancelled", "delivery_uncertain"]) expect(operationsFor(over)).toEqual([]);
});

it("says when a routine runs: its schedule, a zone other than the system's, its state with the underscore spelled out, the next time", () => {
  const base = { id: "R", kind: "recurring" as const, task: "t", title: "t", schedule: "Weekdays 09:00", cron: "0 9 * * 1-5", timezone: "Asia/Taipei", status: "pending", next: null };
  expect(whenLine(base)).toBe("Weekdays 09:00 · Asia/Taipei · pending");
  expect(whenLine({ ...base, timezone: "system_local", status: "delivery_uncertain" })).toBe("Weekdays 09:00 · delivery uncertain");
  const at = "2026-11-03T01:00:00.000Z";
  expect(whenLine({ ...base, kind: "once", schedule: at, next: at })).toBe(`${new Date(at).toLocaleString()} · Asia/Taipei · pending · next ${new Date(at).toLocaleString()}`);
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
  expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["pending", "paused", "fired"]);
  expect(rows.map((row) => [...row.querySelectorAll("button")].map((button) => button.textContent))).toEqual([["Pause", "Cancel"], ["Resume", "Cancel"], []]);
  expect(rows[0]!.querySelector(".routine-when")!.textContent).toBe("Every day 08:15 · pending");
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  expect(document.head.querySelector("style")?.textContent).toContain(".routine-buttons");

  (rows[0]!.querySelector("button") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(root.querySelector("li")!.getAttribute("data-status")).toBe("paused"));
  expect(calls.at(-1)).toEqual(["change", { botId: "B1", operation: "pause", id: "A" }]);

  (root.querySelectorAll("li")[1]!.querySelectorAll("button")[1] as HTMLButtonElement).click();
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
