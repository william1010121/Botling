// botling.usage's program part: it hands the core's usage to its frames and counts finished turns.
import { expect, it, vi } from "vitest";
import type { BotlingApi, PluginEvents } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

function fake(view: unknown) {
  const exposed = new Map<string, () => unknown>();
  let turnFinished: ((data: PluginEvents["turnFinished"]) => void) | null = null;
  const off = vi.fn();
  const api = {
    subscriptions: [] as (() => void)[],
    usage: { view: vi.fn(async () => view) },
    ui: { expose: (method: string, fn: () => unknown) => { exposed.set(method, fn); return () => {}; } },
    events: { on: (event: string, fn: typeof turnFinished) => { if (event === "turnFinished") turnFinished = fn; return off; } },
  };
  return { api: api as unknown as BotlingApi & typeof api, exposed, finish: () => turnFinished!({ botId: "main", ok: true, reply: "" }), off };
}

it("exposes `usage` (the core's view, read again each time) and `turn` (how many turns finished since it started)", async () => {
  const { api, exposed, finish, off } = fake({ day: "2026-11-02" });
  activate(api);
  expect([...exposed.keys()].sort()).toEqual(["turn", "usage"]);
  expect(await exposed.get("usage")!()).toEqual({ day: "2026-11-02" });
  await exposed.get("usage")!();
  expect(api.usage.view).toHaveBeenCalledTimes(2);
  expect(exposed.get("turn")!()).toBe(0);
  finish(); finish();
  expect(exposed.get("turn")!()).toBe(2);
  expect(api.subscriptions).toEqual([off]);
});
