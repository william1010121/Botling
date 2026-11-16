// @vitest-environment jsdom
// `ccb.host.status()` / `ccb.host.onStatus()` of a plugin frame (2026-11-16, for the design-duel tab): the page answers from the core's
// plugin list (`hostState`), the frame's page offers both calls, and the page tells the frame when the state changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_STATES } from "../../../Web/src/frame-protocol";
import { PluginView } from "../../src/contract";
import { panelPage } from "../../src/renderer/panel-page";
import { pluginFrameHost } from "../../src/renderer/plugin-frame-host";
import type { Client } from "../../src/renderer/client";
import { desktop } from "../helpers";

const host = (plugins: { name: string; hostState?: string }[] | Error) => pluginFrameHost({
  client: { request: async (cmd: { type: string }) => { if (plugins instanceof Error) throw plugins; expect(cmd.type).toBe("plugins.list"); return { plugins, tiles: [] }; } } as unknown as Client,
  components: () => ({}), bots: () => [], ask: (_view, _approve, done) => done(false),
});

describe("the page answers hostStatus from the core's plugin list", () => {
  it("is the state the core gave for that plugin; a plugin the list does not have, or an older core that gave none, is `none`", async () => {
    const h = host([{ name: "duel", hostState: "held" }, { name: "other", hostState: "running" }, { name: "old" }]);
    await expect(h.hostStatus!("duel")).resolves.toBe("held");
    await expect(h.hostStatus!("other")).resolves.toBe("running");
    await expect(h.hostStatus!("old")).resolves.toBe("none");
    await expect(h.hostStatus!("missing")).resolves.toBe("none");
  });
  it("a failed list is an error, not a state", async () => {
    await expect(host(new Error("list failed")).hostStatus!("duel")).rejects.toThrow("list failed");
  });
});

describe("the contract and the frame's page", () => {
  it("PluginView's hostState is exactly the states a frame can be told (HOST_STATES), and optional", () => {
    const shape = PluginView.shape.hostState;
    for (const state of HOST_STATES) expect(shape.safeParse(state).success).toBe(true);
    expect(shape.safeParse("crashed").success).toBe(false);
    expect(shape.safeParse(undefined).success).toBe(true);
  });
  it("a frame's page has ccb.host.status() (a hostStatus request) and ccb.host.onStatus() (the page's \"hostStatus\" event)", () => {
    const page = panelPage("duel", "main", "export function activate() {}", {});
    expect(page).toContain('status: () => ask({ ccb: "hostStatus" })');
    expect(page).toContain('onStatus: (handler) => ccb.on("hostStatus", handler)');
  });
  it("the page tells the frame when its plugin's state changes, from every plugin list it gets", () => {
    const source = readFileSync(join(desktop, "src/renderer/Plugins.tsx"), "utf8");
    const block = source.slice(source.indexOf('event.type === "plugins.updated"'), source.indexOf('event.type !== "plugins.emit"'));
    expect(block).toContain("hostState");
    expect(block).toContain('frameEvent("hostStatus", state)');
    expect(block).toContain("state !== lastHost");
  });
});
