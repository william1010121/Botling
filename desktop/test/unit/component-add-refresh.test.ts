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
      expect(text).toMatch(/^\(App: Components were updated;.*You have 2 \/ 20\.\)\nNew on your list, with usage:\n- todo: /);
      expect(text).toContain("@flux-k8s show the todo");
      // Said once: the turn after it carries nothing more.
      const next = flux.newTurn("tidy", "again", null);
      next.guest = true;
      expect(flux.compose(next, false)).toBe("again");
    } finally { await core.shutdown(); }
  });
});
