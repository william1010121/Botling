// Maintainer puts a shared-library component on another bot's list: that bot's very next turn, also one it takes
// as an @ call-in from another chat (a "guest" turn), carries the new list entry; it need not be woken first.
import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";
import { writeLibrary } from "../fixtures/components";

const FLUX = "6AC64E3A-C7D7-4000-8000-000000000001";

describe("a component added to a bot's list", () => {
  it("reaches the bot with its next turn, including a call-in turn", async () => {
    const dir = tempDir("component-add-refresh");
    const folder = tempDir("component-add-refresh-flux");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeLibrary(dir);
    saveProjectRow(dir, { id: FLUX, name: "flux-k8s", folder, avatar: "cloud" });
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    try {
      const flux = ((core as any).bots as Map<string, Bot>).get(FLUX)! as any;
      flux.setComponentList(["status"]);
      // Told at its wake: status is on its list, todo is not.
      expect(flux.componentNote()).toContain("Components in the chat: 1 / 20 yours");
      // Maintainer gives it todo while it is awake.
      expect((core as any).maintainer.giveComponent("todo", flux)).toBe(true);
      const call = flux.newTurn("tidy", "@flux-k8s show the todo", null);
      call.guest = true;
      call.callIn = "caller";
      const text: string = flux.compose(call, false);
      expect(text).toMatch(/^\(App: Components were updated;.*You have 2 \/ 20\.\)\nNew on your list:\n- todo \(JSON\): /);
      expect(text).toContain("@flux-k8s show the todo");
      // Said once: the turn after it carries nothing more.
      const next = flux.newTurn("tidy", "again", null);
      next.guest = true;
      expect(flux.compose(next, false)).toBe("again");
    } finally { await core.shutdown(); }
  });

  // Components on demand (audit 2026-11-11): the wake lists one line each; app_component_usage gives one whole usage.
  it("app_component_usage gives a component's whole usage to the bot, not to a worker", async () => {
    const dir = tempDir("component-usage");
    const folder = tempDir("component-usage-flux");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeLibrary(dir);
    saveProjectRow(dir, { id: FLUX, name: "flux-k8s", folder, avatar: "cloud" });
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    try {
      const flux = ((core as any).bots as Map<string, Bot>).get(FLUX)! as any;
      flux.setComponentList(["status"]);
      expect(flux.componentNote()).toContain("\n- status (JSON): Status card: one line saying whether something is OK.\n");
      const status = await flux.botTool("app_component_usage", { name: "status" }, "coordinator");
      expect(status).toEqual({ name: "status", yours: true, command: null, usage: "- status: Status card: one line saying whether something is OK.\n  Data: {\"ok\": true}\n  Sizes: 2x1, 2x2\n  Icon: 📊" });
      const gitlog = await flux.botTool("app_component_usage", { name: "GitLog" }, "coordinator");
      expect(gitlog).toMatchObject({ name: "gitlog", yours: false, command: "printf '{\"n\":3}'" });
      expect(gitlog.note).toContain('<component name="gitlog">add it to my list</component>');
      await expect(flux.botTool("app_component_usage", { name: "nope" }, "coordinator")).rejects.toThrow(/No component named "nope"\. The library has: .*status/);
      await expect(flux.botTool("app_component_usage", { name: "status" }, "worker")).rejects.toThrow(/Only the bot itself/);
    } finally { await core.shutdown(); }
  });
});
