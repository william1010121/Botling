// botling.deps's program part: it hands the core's board to its frame, read again at each ask.
import { expect, it, vi } from "vitest";
import type { BotlingApi } from "../../../../Web/host/src/api";
import { activate } from "../src/host";

it("exposes `deps` (the core's board, asked again each time) and nothing else", async () => {
  const exposed = new Map<string, () => unknown>();
  const api = { plugins: { deps: vi.fn(async () => ({ plugins: [], edges: [], missing: [], slots: [] })) }, ui: { expose: (method: string, fn: () => unknown) => { exposed.set(method, fn); return () => {}; } } };
  activate(api as unknown as BotlingApi);
  expect([...exposed.keys()]).toEqual(["deps"]);
  expect(await exposed.get("deps")!()).toEqual({ plugins: [], edges: [], missing: [], slots: [] });
  await exposed.get("deps")!();
  expect(api.plugins.deps).toHaveBeenCalledTimes(2);
});
