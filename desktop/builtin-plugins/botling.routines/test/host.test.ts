// botling.routines' program part: it passes a bot's routine list and Pause / Resume / Cancel to the core, and nothing else.
import { expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

function fake() {
  const exposed = new Map<string, (params: unknown) => unknown>();
  const list = { routines: [{ id: "R1", kind: "once", task: "t", title: "t", schedule: "s", timezone: "system_local", status: "pending", next: null }], error: null };
  const api = {
    routines: { list: vi.fn(async () => list), change: vi.fn(async () => ({ routines: [], error: null })), add: vi.fn() },
    ui: { expose: (method: string, fn: (params: unknown) => unknown) => { exposed.set(method, fn); return () => {}; } },
  };
  return { api: api as unknown as BotlingApi & typeof api, exposed, list };
}

it("exposes `list` and `change`, which ask the core for that bot", async () => {
  const { api, exposed, list } = fake();
  activate(api);
  expect([...exposed.keys()].sort()).toEqual(["change", "list"]);
  expect(await exposed.get("list")!({ botId: "B1" })).toBe(list);
  expect(api.routines.list).toHaveBeenCalledWith("B1");
  await exposed.get("change")!({ botId: "B1", operation: "pause", id: "R1" });
  expect(api.routines.change).toHaveBeenCalledWith("B1", "pause", "R1");
});

it("refuses a frame's request for anything but pause, resume or cancel (no create), and one that names no bot or routine", () => {
  const { api, exposed } = fake();
  activate(api);
  expect(() => exposed.get("change")!({ botId: "B1", operation: "create", id: "R1" })).toThrow("paused, resumed or cancelled");
  expect(() => exposed.get("change")!({ botId: "B1", operation: "pause" })).toThrow("routine is missing");
  expect(() => exposed.get("change")!({ operation: "pause", id: "R1" })).toThrow("bot is missing");
  expect(() => exposed.get("list")!({})).toThrow("bot is missing");
  expect(() => exposed.get("list")!(null)).toThrow("bot is missing");
  expect(api.routines.change).not.toHaveBeenCalled();
  expect(api.routines.list).not.toHaveBeenCalled();
});
