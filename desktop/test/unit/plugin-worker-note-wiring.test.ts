// @vitest-environment node
// A worker's note (app_notify_owner) reaches the plugins as `workerNote` through the real chain: Bot.workerNote → BotWorkers.workerNote →
// the bot's `workerNoted` option (CoreBots) → Core.workerNoted → CorePluginSide → plugins.event. Cutting any link makes the event disappear.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const ID = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";

describe("workerNote through the real chain", () => {
  it("a note a bot receives from its worker is told to the plugins with the worker's id, kind and words (cut at 20,000), in the plugin's bot id", async () => {
    const dir = tempDir("worker-note-wiring");
    const folder = tempDir("worker-note-wiring-bot");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    saveProjectRow(dir, { id: ID, name: "botling", folder, avatar: "triangle" });
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    try {
      const bot = ((core as any).bots as Map<string, Bot>).get(ID)!;
      vi.spyOn(bot as any, "deliver").mockImplementation(async () => {});
      const heard = vi.spyOn((core as any).plugins, "event");
      const delivered = bot.workerNote({ id: "W1", kind: "question", name: "deploy", message: "x".repeat(25_000), files: [] } as any, "<app_worker_note task_id=\"W1\" kind=\"question\">x</app_worker_note>");
      expect(delivered).toBe(true);
      const notes = heard.mock.calls.filter(([name]) => name === "workerNote");
      expect(notes).toHaveLength(1);
      expect(notes[0]![1]).toMatchObject({ botId: core.outId(ID), workerId: "W1", kind: "question" });
      expect(((notes[0]![1] as { message: string }).message).length).toBe(20_000);
      // a note with no worker id (an older record) is not told
      bot.workerNote({ kind: "report", name: "deploy", message: "no id", files: [] } as any, "<app_worker_note kind=\"report\">no id</app_worker_note>");
      expect(heard.mock.calls.filter(([name]) => name === "workerNote")).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await core.shutdown(); }
  });
});
