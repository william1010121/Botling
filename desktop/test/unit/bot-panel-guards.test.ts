// @vitest-environment jsdom
// The guards of the bot-panel plugin's reading side (panel-slot.ts) and of its activate (plugins/bot-panel/index.ts), each with a
// test that fails when the guard is removed (M7-03a review: these five survived the mutation check). Stub kernels: only the
// methods the code under test calls.
import { describe, expect, it, vi } from "vitest";
import type { Kernel } from "../../../Web/src/plugin-kernel";
import { BOT_PANEL_PLUGIN, MAIN_SLOT, PANEL_BLOCKS, SECTION_SLOT, TAKEOVER_SLOT, TILE_SLOTS } from "../../src/renderer/panel-names";
import { panelState, registeredPanelBlocks } from "../../src/renderer/panel-slot";
import { activate } from "../../src/renderer/plugins/bot-panel";

const kernelWith = (entries: { plugin: string; entry: unknown }[], state = "active") =>
  ({ entries: () => entries, state: () => state }) as unknown as Kernel;
const own = (entry: unknown) => ({ plugin: BOT_PANEL_PLUGIN, entry });

describe("registeredPanelBlocks: only well-formed blocks of the plugin, once each", () => {
  it("skips an entry of another kind, a block id that is not one of PANEL_BLOCKS, and a repeated block", () => {
    const kernel = kernelWith([
      own({ kind: "panel-block", block: "waiting" }),
      own({ kind: "feed", block: "results" }),
      own({ kind: "panel-block", block: "constructor" }),
      own({ kind: "panel-block", block: "waiting" }),
      own({ kind: "panel-block", block: "settled" }),
    ]);
    expect(registeredPanelBlocks(kernel)).toEqual(["waiting", "settled"]);
  });
});

describe("panelState: the host's answer comes first", () => {
  it("unavailable while the kernel still holds the plugin active (the host already unloaded or refused it)", () => {
    const kernel = kernelWith([own({ kind: "panel-block", block: "waiting" })]);
    expect(panelState(kernel, { unavailable: () => true })).toEqual({ blocks: [], unavailable: true });
    expect(panelState(kernel, { unavailable: () => false })).toEqual({ blocks: ["waiting"], unavailable: false });
  });
});

describe("activate: a block the kernel refuses fails the load", () => {
  it("rejects when contribute answers null, after owning its slots (the panel's three and the three tile surfaces, M7-03b)", async () => {
    const provideSlot = vi.fn();
    const contribute = vi.fn(() => null);
    const api = { define: async (declaration: { name: string }, register: (kernel: Kernel, plugin: string) => void) => {
      register({ provideSlot, contribute } as unknown as Kernel, declaration.name);
      return () => {};
    } };
    await expect(activate(api)).rejects.toThrow(`the kernel refused the ${PANEL_BLOCKS[0]} block`);
    expect(provideSlot.mock.calls.map(([, slot]) => slot)).toEqual([MAIN_SLOT, SECTION_SLOT, TAKEOVER_SLOT, TILE_SLOTS.board, TILE_SLOTS.whiteboard, TILE_SLOTS.pin]);
    expect(contribute).toHaveBeenCalledTimes(1);
  });
});
