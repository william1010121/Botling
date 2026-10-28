// A bot's own picture for its card on the main bot's whiteboard: the <whiteboard> tag (parsed out
// of the reply like <show>), the line every bot but the main bot is told, and, through the built
// core, the picture kept per bot (whiteboard.json), drawn from its data or, once allowed, its command.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReply, saysNothing } from "../../src/core/reply";
import { botPrompts, desktopPrompts, TASK_STAGE_SENTENCE, WHITEBOARD_PICTURE_LINE } from "../../src/core/prompts";
import { tempDir, until } from "../helpers";
import { CoreHarness } from "../core-harness";
import { writeLibrary } from "../fixtures/components";
import { WhiteboardView } from "../../src/contract";

describe("<whiteboard> in a reply", () => {
  it("is taken out of the text: name, JSON data or a command, size 1x1 (default) or 2x1; the last one counts", () => {
    expect(parseReply('Done. <whiteboard name="status" size="2x1">{"ok":true}</whiteboard>')).toMatchObject({ body: "Done.", whiteboard: { name: "status", data: '{"ok":true}', size: "2x1" } });
    expect(parseReply('<whiteboard name="gitlog" command="git log --oneline"></whiteboard>').whiteboard).toEqual({ name: "gitlog", data: "null", command: "git log --oneline", size: "1x1" });
    expect(parseReply('<whiteboard name="a">{"n":1}</whiteboard> then <whiteboard name="b" size="4x4">{"n":2}</whiteboard>').whiteboard).toEqual({ name: "b", data: '{"n":2}', size: "1x1" });
    expect(parseReply("Cleared. <whiteboard clear/>")).toMatchObject({ body: "Cleared.", whiteboard: { clear: true } });
    expect(parseReply("Nothing here").whiteboard).toBeUndefined();
    // In code it is an example; broken JSON or no name draws nothing (and the tag still leaves the text).
    expect(parseReply('Like `<whiteboard name="x">{}</whiteboard>`').whiteboard).toBeUndefined();
    const broken = parseReply('Oops <whiteboard name="x">{broken</whiteboard>');
    expect([broken.body, broken.whiteboard]).toEqual(["Oops", undefined]);
    // A reply that is only the tag says nothing in the chat.
    expect(saysNothing('<whiteboard name="status">{"ok":true}</whiteboard>')).toBe(true);
  });
});

describe("the line bots are told", () => {
  const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });
  it("is added after the <show> line for every bot but the main bot; the Swift-matched prompts stay as they are", () => {
    for (const role of ["manager", "bot"] as const) {
      const plain = botPrompts({ profile: profile(role) });
      const system = desktopPrompts(plain, profile(role)).system;
      expect(plain.system).not.toContain("<whiteboard");
      expect(system).toContain(`</show> to your reply.\n${WHITEBOARD_PICTURE_LINE}\n`);
    }
    const main = botPrompts({ profile: profile("main") });
    // The main bot gets no picture line; every bot gets only the <task> stage sentence besides.
    expect(desktopPrompts(main, profile("main")).system).toBe(main.system.replace(" done or stopped.", ` done or stopped. ${TASK_STAGE_SENTENCE}`));
    expect(WHITEBOARD_PICTURE_LINE).toContain('<whiteboard name="component name" size="1x1">JSON</whiteboard>');
  });
});

const harnesses: CoreHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});

describe("a bot's whiteboard picture through the core", () => {
  it("is kept per bot, shown in whiteboard.view, replaced, cleared; a command picture runs only once allowed", async () => {
    const dir = tempDir("wb-picture");
    writeLibrary(dir);
    const folder = join(tempDir("wb-picture-proj"), "Site");
    mkdirSync(folder, { recursive: true });
    const c = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_PLAIN_SHELL: "1", BOTLING_WAITING_SCAN_MS: "0" });
    harnesses.push(c);
    const { botId } = await c.call({ type: "projects.add", folder });
    const say = async (text: string) => {
      const { turnId } = await c.call({ type: "chat.send", botId, text });
      await until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId), { what: text });
    };
    const picture = async () => (await c.call({ type: "whiteboard.view" })).bots.find((entry: any) => entry.botId === botId).picture;
    expect(await picture()).toBeNull();

    await say('/say <whiteboard name="status" size="2x1">{"ok":true}</whiteboard>');
    expect(await picture()).toMatchObject({ name: "status", data: '{"ok":true}', size: "2x1", command: null, status: null });
    expect(WhiteboardView.safeParse(await c.call({ type: "whiteboard.view" })).success).toBe(true);
    // Nothing drawn in its chat for it.
    expect((await c.chat(botId)).messages.some((message: any) => message.role === "bot" && message.text.includes("whiteboard"))).toBe(false);
    const store = readdirStore(dir, botId);
    expect(JSON.parse(readFileSync(store, "utf8"))).toMatchObject({ name: "status", data: '{"ok":true}', size: "2x1" });

    // One not in the library is not kept; the picture before stays.
    await say('/say <whiteboard name="nope">{}</whiteboard>');
    expect(await picture()).toMatchObject({ name: "status" });

    // A command picture: waits for your OK, runs only once allowed (in the bot's folder), then shows the output.
    await say("/say <whiteboard name=\"gitlog\"></whiteboard>");
    const waiting = await picture();
    expect(waiting).toMatchObject({ name: "gitlog", command: `printf '{"n":3}'`, folder, status: "approve", size: "1x1" });
    expect(await c.call({ type: "whiteboard.allow", botId, command: "rm -rf /tmp/x", folder })).toEqual({ accepted: false });
    expect(await c.call({ type: "whiteboard.allow", botId, command: waiting.command, folder: "/tmp" })).toEqual({ accepted: false });
    expect(await c.call({ type: "whiteboard.allow", botId, command: waiting.command, folder })).toEqual({ accepted: true });
    const ran = await until(async () => { const shown = await picture(); return shown.status === "done" && shown; });
    expect(ran).toMatchObject({ data: '{"n":3}', error: null });

    await say("/say <whiteboard clear/>");
    expect(await picture()).toBeNull();
    expect(existsSync(store)).toBe(false);
  });
});

function readdirStore(dir: string, botId: string) {
  return join(dir, "projects", botId, "whiteboard.json");
}
