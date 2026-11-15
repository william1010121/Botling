// M7-S70: a bot a plugin made and the user removed stays removed. `Core`'s constructor reads <data>/removed-bots.json into
// `CoreBots.removedPluginBots` (through Core's accessor), and `makeBot` / `createPluginBot` refuse that plugin/name afterwards.
// Left open by the M7-S63 review ("loading removed-bots.json keeps a plugin's bot from being made again").
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { tempDir } from "../helpers";

function core(dir: string) {
  return new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() { /* nothing */ }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
}

describe("removed-bots.json", () => {
  it("is read at start: the plugin's removed bot is not made again, by `makeBot` or by a plugin's `bots.create`", () => {
    const dir = tempDir("core-removed-bots");
    // Keys are `plugin/name` in lower case; a non-string entry is skipped, not thrown on.
    writeFileSync(join(dir, "removed-bots.json"), JSON.stringify(["news/reader", 7, null]));
    const started = core(dir);
    const count = started.profiles.length;
    expect(started.makeBot("Reader", "Read the news", { plugin: "news" })).toEqual({ kind: "removedByUser" });
    // The key is compared in lower case, whatever case the name is asked in.
    expect(started.makeBot("READER", "Read the news", { plugin: "news" })).toEqual({ kind: "removedByUser" });
    expect(() => started.createPluginBot("news", "News", { name: "Reader", job: "Read the news" })).toThrow(/removed the bot "Reader"; it is not made again/);
    expect(started.profiles.length).toBe(count);
    expect(started.profiles.some((profile) => profile.name === "Reader")).toBe(false);
  });

  it("holds only what it names: another plugin, the same name made by the user (no plugin), and another name are still made", () => {
    const dir = tempDir("core-removed-bots-other");
    writeFileSync(join(dir, "removed-bots.json"), JSON.stringify(["news/reader"]));
    const started = core(dir);
    expect(started.makeBot("Reader", "Read the news", { plugin: "weather" }).kind).toBe("made");
    expect(started.makeBot("Writer", "Write the news", { plugin: "news" }).kind).toBe("made");
    // Made by the user (no plugin), in a data folder of its own (the two bots above are saved in this one): the list is about plugins' bots only.
    const other = tempDir("core-removed-bots-user");
    writeFileSync(join(other, "removed-bots.json"), JSON.stringify(["news/reader"]));
    expect(core(other).makeBot("Reader", "Read for me", {}).kind).toBe("made");
  });

  it("a missing or unreadable file starts a core with nothing removed", () => {
    const missing = core(tempDir("core-removed-bots-none"));
    expect(missing.makeBot("Reader", "Read the news", { plugin: "news" }).kind).toBe("made");
    const dir = tempDir("core-removed-bots-bad");
    writeFileSync(join(dir, "removed-bots.json"), "{ not json");
    expect(core(dir).makeBot("Reader", "Read the news", { plugin: "news" }).kind).toBe("made");
  });
});
