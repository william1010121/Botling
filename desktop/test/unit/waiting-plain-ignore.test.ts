// fu-waiting-plain-ignore: a text key in settings' `ignoredWaiting` (`<botId>-<text>`) sets aside plain waiting items only
// (messageId null). A question or card is set aside by its own id (`ignoredAt`), never by a text key, so a plain ignore of
// X cannot hide a later question whose preview is X. Stored keys are neither rewritten nor dropped.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const QUESTION = "DD43524E-1FC7-4DD6-9A50-4A129ADD64AA";
const X = "Which domain?";

const cores: Core[] = [];
afterEach(async () => { for (const core of cores.splice(0)) await core.shutdown().catch(() => {}); });

/** A project whose memory lists X as a plain item; `question` adds an open question (text X, no choice labels, so the preview is X). */
function setup(options: { plain?: boolean; question?: boolean; ignoredKeys?: string[] } = {}) {
  const dir = tempDir("waiting-plain-ignore");
  const folder = tempDir("waiting-plain-ignore-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  if (options.plain) writeFileSync(join(folder, ".bot", "memory.md"), `## Current status\n- Fine\n## Waiting on you\n- ${X}\n`);
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  const store = join(dir, "projects", PROJECT);
  mkdirSync(store, { recursive: true });
  const chat = join(store, "chat.json");
  const settings = join(dir, "settings.json");
  if (options.question) writeFileSync(chat, JSON.stringify([{ id: QUESTION, role: "bot", text: X, date: 814897456.479, choices: [{ recommended: false }] }]));
  if (options.ignoredKeys) writeFileSync(settings, JSON.stringify({ ignoredWaiting: options.ignoredKeys }));
  const open = () => {
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, log: () => undefined });
    cores.push(core);
    return core;
  };
  const keys = () => { try { return (JSON.parse(readFileSync(settings, "utf8")) as { ignoredWaiting?: string[] }).ignoredWaiting ?? []; } catch { return []; } };
  return { dir, chat, settings, open, keys };
}
const mine = (core: Core) => core.waiting().items.filter((item) => item.botId === PROJECT);

describe("waiting: a text-keyed ignore sets aside plain items only", () => {
  it("plain ignore of X, then a question whose preview is X appears: the question stays visible", async () => {
    const h = setup({ plain: true });
    const first = h.open();
    expect(mine(first)).toEqual([{ botId: PROJECT, text: X, messageId: null }]);
    first.ignoreWaiting(PROJECT, X);
    expect(h.keys()).toEqual([`${PROJECT}-${X}`]);
    expect(mine(first)).toEqual([]);
    await first.shutdown();
    // Later the bot asks a question with the same preview (a peer made it list X first, then ignored it).
    writeFileSync(h.chat, JSON.stringify([{ id: QUESTION, role: "bot", text: X, date: 814897456.479, choices: [{ recommended: false }] }]));
    const second = h.open();
    expect(mine(second)).toMatchObject([{ botId: PROJECT, text: X, messageId: QUESTION }]);
  });

  it("a stored key still hides the plain item with that text, and the key is kept as it is", () => {
    const h = setup({ plain: true, ignoredKeys: [`${PROJECT}-${X}`, "other-key"] });
    const core = h.open();
    expect(mine(core)).toEqual([]);
    core.ignoreWaiting(PROJECT, X);
    expect(h.keys()).toEqual([`${PROJECT}-${X}`, "other-key"]);
  });

  it("stored keys (the first line, or the preview) no longer hide a question; its own id-keyed ignore still does", () => {
    const h = setup({ question: true, ignoredKeys: [`${PROJECT}-${X}`] });
    const core = h.open();
    expect(mine(core)).toMatchObject([{ messageId: QUESTION }]);
    expect((core as any).ignoreQuestion(PROJECT, QUESTION)).toEqual({ accepted: true });
    expect(mine(core)).toEqual([]);
  });

  it("ignoring by text a text that is only an open question sets that question aside by id and writes no key", () => {
    const h = setup({ question: true });
    const core = h.open();
    const after = core.ignoreWaiting(PROJECT, X);
    expect(after.items.filter((item) => item.botId === PROJECT)).toEqual([]);
    expect((core as any).bot(PROJECT).line(QUESTION).ignoredAt).toEqual(expect.any(String));
    expect(h.keys()).toEqual([]);
  });

  it("a peer may not set a question aside by text, even with a key for that text already stored", () => {
    const h = setup({ question: true, ignoredKeys: [`${PROJECT}-${X}`] });
    const core = h.open();
    expect(core.peerMayIgnoreWaiting(PROJECT, X)).toBe(false);
    // Without an open question the repeat of an accepted ignore is still a no-op (the second owner check).
    const plain = setup({ plain: true });
    const other = plain.open();
    expect(other.peerMayIgnoreWaiting(PROJECT, X)).toBe(true);
    other.ignoreWaiting(PROJECT, X);
    expect(other.peerMayIgnoreWaiting(PROJECT, X)).toBe(true);
  });

  it("review: a plain item and an app card with the same text (the server's own ask): the peer's text ignore sets aside the plain item only", () => {
    // A bot's own `openQuestion()` skips app lines, so a server ask (M5-06c) sits on the list beside the bot's plain items.
    const PLAIN = "1. Allow";
    const folder = tempDir("waiting-plain-ignore-mixed");
    mkdirSync(join(folder, ".bot"), { recursive: true });
    writeFileSync(join(folder, ".bot", "memory.md"), `## Current status\n- Fine\n## Waiting on you\n- ${PLAIN}\n`);
    const dir = tempDir("waiting-plain-ignore-mixed-data");
    saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
    mkdirSync(join(dir, "projects", PROJECT), { recursive: true });
    const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
      routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, log: () => undefined });
    cores.push(core);
    void core.serverAsk(PROJECT, { text: "Fetch it", choices: ["Allow"] });
    const card = mine(core).find((item) => item.messageId !== null);
    expect(card).toMatchObject({ text: PLAIN, messageId: expect.any(String) });
    expect(mine(core).filter((item) => item.text === PLAIN)).toHaveLength(2);
    // The peer passes on the plain item; the handler must not reach the card through it.
    expect(core.peerMayIgnoreWaiting(PROJECT, PLAIN)).toBe(true);
    core.ignoreWaiting(PROJECT, PLAIN);
    expect(mine(core)).toEqual([card]);
    expect((core as any).bot(PROJECT).line(card!.messageId).ignoredAt).toBeUndefined();
    expect((JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { ignoredWaiting: string[] }).ignoredWaiting).toEqual([`${PROJECT}-${PLAIN}`]);
    // A repeat now meets only the card: refused (a re-run of the handler would set the card aside by id).
    expect(core.peerMayIgnoreWaiting(PROJECT, PLAIN)).toBe(false);
  });
});
