// Phase 4a: the main bot's world as 1.x builds it (Workspace.swift): adding a project, the main bot's
// <new-project> requests and their card, the project list it wakes with, inbox delivery after its
// replies, `--add-dir` for every bot's notes, and what waits on you (with ignoring) for the right panel.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import { childFolders, defaultName, firstLine, folderPath, memoryItems, nextAvatar, prepareNotesFolder, projectFolders, saveProjectRow } from "../../src/core/projects";
import { headArguments } from "../../src/core/agent/head";

const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";
const harnesses: CoreHarness[] = [];
function core(dir: string, env: Record<string, string> = {}) {
  const harness = new CoreHarness(dir, { FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), BOTLING_ROUTINE_TICK_MS: "0", BOTLING_COMPONENT_SCAN_MS: "0", BOTLING_WAITING_SCAN_MS: "0", ...env });
  harnesses.push(harness);
  return harness;
}
afterEach(async () => {
  for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null && harness.child.signalCode === null) await harness.kill("SIGKILL");
});
const logged = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const project = (name: string, marker = true) => {
  const folder = join(tempDir("proj"), name);
  mkdirSync(folder, { recursive: true });
  if (marker) writeFileSync(join(folder, "package.json"), "{}");
  return folder;
};
async function reply(c: CoreHarness, botId: string, text: string) {
  const { turnId } = await c.call({ type: "chat.send", botId, text });
  return until(() => c.of("turn.finished").find((e) => (e.event as any).turnId === turnId), { what: `reply to ${text}` });
}

describe("the main bot's helpers (Workspace.swift, ProjectBotNaming, MemoryFile)", () => {
  it("avatars, folder paths, names and first lines as 1.x", () => {
    expect(nextAvatar([])).toBe("square");
    expect(nextAvatar(["square", "triangle"])).toBe("hexagon");
    expect(folderPath("~/x/")).toBe(join(homedir(), "x"));
    expect(folderPath("file:///tmp/a%20b/")).toBe("/tmp/a b");
    expect(folderPath("/a/b/../c")).toBe("/a/c");
    expect(folderPath("relative/path")).toBeNull();
    expect(defaultName("/x/My App")).toBe("My App");
    expect(defaultName("/x/botling")).toBe("botling");
    expect(firstLine("\n\nfirst\nsecond")).toBe("first");
  });

  it("finds the outermost project folders below a folder, skipping hidden and build folders", () => {
    const root = tempDir("find");
    for (const path of ["a/.git", "b/inner/c", "skip/node_modules/x", "d.app", ".hidden/e"]) mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, "b", "inner", "Cargo.toml"), "");
    writeFileSync(join(root, "b", "inner", "c", "package.json"), "{}");
    writeFileSync(join(root, "skip", "node_modules", "x", "package.json"), "{}");
    writeFileSync(join(root, ".hidden", "e", "Makefile"), "");
    expect(projectFolders(root)).toEqual([join(root, "a"), join(root, "b", "inner")]);
    expect(childFolders(root)).toEqual([join(root, "a"), join(root, "b"), join(root, "d.app"), join(root, "skip")]);
    expect(childFolders(join(root, "nope"))).toBeNull();
  });

  it("the notes folder hides itself from git; a projects.json row keeps the others and their keys", () => {
    const folder = project("notes");
    prepareNotesFolder(folder);
    expect(readFileSync(join(folder, ".bot", ".gitignore"), "utf8")).toBe("*\n");
    const root = tempDir("rows");
    writeFileSync(join(root, "projects.json"), JSON.stringify([{ id: "A", name: "a", folder: "file:///a/", avatar: "square", extra: 1 }]));
    saveProjectRow(root, { id: "B", name: "notes", folder, avatar: "triangle" });
    const rows = JSON.parse(readFileSync(join(root, "projects.json"), "utf8"));
    expect(rows).toEqual([{ id: "A", name: "a", folder: "file:///a/", avatar: "square", extra: 1 }, { id: "B", name: "notes", folder: pathToFileURL(folder).href + "/", avatar: "triangle" }]);
  });

  it("reads a memory.md's sections by heading (English or Chinese) or by place", () => {
    const text = "# Memory\n## Current status\nfine\n## In progress\n- tests\n## Waiting on you\n- pick a name\n- (none yet)\n* —\n1. ship it?\n## Decided\n- x";
    expect(memoryItems(text, "waitingOnYou")).toEqual(["pick a name", "ship it?"]);
    expect(memoryItems(text, "inProgress")).toEqual(["tests"]);
    expect(memoryItems("## 現在狀態\n\n## 等你決定的事\n- 選一個", "waitingOnYou")).toEqual(["選一個"]);
    expect(memoryItems("## A\n## B\n## C\n- third\n## D", "waitingOnYou")).toEqual(["third"]);
  });

  it("a head may use more folders (--add-dir), not in harmless mode", () => {
    const base = { command: "claude", cwd: "/w", sessionId: "S", resume: false, allowedTools: [], addDirs: ["/p/.bot", "/q/.bot"] };
    const args = headArguments(base as any);
    expect(args.join(" ")).toContain("--add-dir /p/.bot --add-dir /q/.bot");
    expect(headArguments({ ...base, harmless: true } as any)).not.toContain("--add-dir");
  });
});

describe("projects and the main bot's world through the core", () => {
  it("adds a folder as a project before Maintainer, once; it stays after a restart", async () => {
    const dir = tempDir("add");
    const folder = project("Widget");
    const c = core(dir);
    const added = await c.call({ type: "projects.add", folder: folder + "/" });
    expect(added.added).toBe(true);
    expect(await c.call({ type: "projects.add", folder })).toEqual({ botId: added.botId, added: false });
    await expect(c.call({ type: "projects.add", folder: join(folder, "missing") })).rejects.toThrow("not_found");
    const update = await until(() => c.of("bot.updated").find((e) => (e.event as any).bot.id === added.botId));
    expect((update.event as any).bot).toMatchObject({ name: "Widget", role: "manager", avatar: "square" });
    const order = (await c.call({ type: "chat.snapshot" })).bots.map((bot: any) => bot.id);
    expect(order.indexOf(added.botId)).toBe(order.indexOf(MAINTAINER) - 1);
    expect(existsSync(join(folder, ".bot", ".gitignore"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "projects.json"), "utf8"))).toEqual([{ id: added.botId, name: "Widget", folder: pathToFileURL(folder).href + "/", avatar: "square" }]);
    await c.kill();
    const again = core(dir);
    const bots = (await again.call({ type: "chat.snapshot" })).bots;
    expect(bots.find((bot: any) => bot.id === added.botId)).toMatchObject({ name: "Widget", role: "manager" });
    // A message to the new manager works (its head runs in the project's folder).
    const second = await again.call({ type: "projects.add", folder: project("Gadget") });
    await reply(again, second.botId, "hello");
  });

  it("wakes the main bot with the project list; what it writes into an inbox goes to that bot after its reply", async () => {
    const dir = tempDir("inbox");
    const folder = project("Shop");
    const first = core(dir);
    const { botId } = await first.call({ type: "projects.add", folder });
    await first.kill();
    const c = core(dir);
    await reply(c, MAIN, "how are things");
    const wake: string = logged(join(dir, "claude-input.log")).find((line) => line.text.includes("how are things")).text;
    expect(wake).toContain(`(App: Project list. To check progress, read the memory file and do not wake the manager; to hand off work, append a line to the end of the inbox file.)\n- Shop (folder ${folder}): memory file ${join(folder, ".bot", "memory.md")}; inbox file ${join(folder, ".bot", "inbox.md")}`);
    expect(wake).toContain(`- Maintainer (plugin-library extensions and in-chat components only): memory file ${join(dir, "plugins", ".bot", "memory.md")}; inbox file ${join(dir, "plugins", ".bot", "inbox.md")}`);
    // The main bot hands off work by writing the inbox; its next reply delivers it.
    writeFileSync(join(folder, ".bot", "inbox.md"), "Please add a checkout page.\n");
    await reply(c, MAIN, "/say Handed it to Shop.");
    const chat = await until(async () => { const shop = await c.chat(botId); return shop.messages.some((message: any) => message.role === "relay") ? shop : null; }, { what: "the relay" });
    expect(chat.messages.find((message: any) => message.role === "relay").text).toBe("Please add a checkout page.");
    expect(readFileSync(join(folder, ".bot", "inbox.md"), "utf8")).toBe("");
    await until(() => logged(join(dir, "claude-input.log")).some((line) => line.text.includes("Please add a checkout page.")), { what: "the manager hearing it" });
  });

  it("<new-project>: a card asks first; Add makes the projects and gives each its task; missing and too-broad folders are said", async () => {
    const dir = tempDir("propose");
    const parent = tempDir("parent");
    for (const name of ["one", "two"]) { mkdirSync(join(parent, name)); writeFileSync(join(parent, name, "go.mod"), ""); }
    const c = core(dir);
    await reply(c, MAIN, `/say On it.\n<new-project folder="${parent}/**">write a README</new-project>\n<new-project folder="${join(parent, "gone")}"/>\n<new-project folder="${dir}"/>`);
    const chat = await until(async () => { const main = await c.chat(); return main.messages.find((message: any) => message.text.startsWith("Add these 2 folders")) ? main : null; }, { what: "the card" });
    const card = chat.messages.find((message: any) => message.text.startsWith("Add these 2 folders"));
    expect(card.text).toContain(`- **one** \`${join(parent, "one")}\``);
    expect(card.text).toContain("Then each manager starts on: write a README");
    expect(card.choices.map((choice: any) => choice.label)).toEqual(["Add all 2", "Don't add"]);
    expect(chat.messages.some((message: any) => message.text === `Couldn't add a project: there is no folder at ${join(parent, "gone")}.`)).toBe(true);
    expect(chat.messages.some((message: any) => message.text.startsWith(`Couldn't add ${dir} as a project`))).toBe(true);
    expect(JSON.stringify((await c.call({ type: "chat.snapshot" })).bots)).not.toContain('"one"');
    await c.call({ type: "chat.choose", botId: MAIN, messageId: card.id, index: 0 });
    const bots = await until(async () => { const all = (await c.call({ type: "chat.snapshot" })).bots; return all.filter((bot: any) => bot.role === "manager" && bot.id !== MAINTAINER).length === 2 ? all : null; }, { what: "two projects" });
    const one = bots.find((bot: any) => bot.name === "one");
    expect(one.avatar).toBe("square");
    await until(async () => (await c.chat(one.id)).messages.some((message: any) => message.role === "relay" && message.text === "write a README"), { what: "the task" });
    await until(async () => (await c.chat()).messages.some((message: any) => message.text === "Added one, two as projects; the managers with a task are on it."), { what: "the notice" });
    // Asked again for a folder that is a project now: the task goes straight to its manager.
    await reply(c, MAIN, `/say <new-project folder="${join(parent, "one")}">and a licence</new-project>`);
    await until(async () => (await c.chat(one.id)).messages.some((message: any) => message.text === "and a licence"), { what: "the second task" });
    await until(async () => (await c.chat()).messages.some((message: any) => message.text === "one is already a project; any task went to its manager."));
  });

  it("Don't add adds nothing", async () => {
    const dir = tempDir("decline");
    const folder = project("Nope");
    const c = core(dir);
    await reply(c, MAIN, `/say <new-project folder="${folder}"/>`);
    const card = await until(async () => (await c.chat()).messages.find((message: any) => message.text.startsWith("Add **Nope** as a project?")));
    expect(card.choices.map((choice: any) => choice.label)).toEqual(["Add as project", "Don't add"]);
    await c.call({ type: "chat.choose", botId: MAIN, messageId: card.id, index: 1 });
    await until(async () => (await c.chat()).messages.find((message: any) => message.id === card.id && message.chosen != null));
    expect(existsSync(join(dir, "projects.json"))).toBe(false);
  });

  it("what waits on you: a memory's \"Waiting on you\", a manager's \"In progress\"; ignoring takes it off and is kept", async () => {
    const dir = tempDir("waiting");
    const folder = project("Blog");
    const c = core(dir);
    const { botId } = await c.call({ type: "projects.add", folder });
    expect(await c.call({ type: "waiting.list" })).toEqual({ items: [], doing: {} });
    writeFileSync(join(folder, ".bot", "memory.md"), "## Current status\nok\n## In progress\n- the theme\n## Waiting on you\n- Which domain?\n- Publish now?\n## Decided\n");
    const listed = await c.call({ type: "waiting.list" });
    expect(listed).toEqual({ items: [{ botId, text: "Which domain?", messageId: null }, { botId, text: "Publish now?", messageId: null }], doing: { [botId]: "the theme" } });
    expect((await c.call({ type: "chat.snapshot" })).waiting).toEqual(listed);
    const after = await c.call({ type: "waiting.ignore", botId, text: "Which domain?" });
    expect(after.items.map((item: any) => item.text)).toEqual(["Publish now?"]);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).ignoredWaiting).toEqual([`${botId}-Which domain?`]);
    expect(c.of("waiting.updated").at(-1)!.event).toEqual({ type: "waiting.updated", waiting: after });
    // A question in a bot's own chat comes first, instead of its memory's list.
    await reply(c, botId, "/choices");
    const updated = await until(() => c.of("waiting.updated").find((e) => (e.event as any).waiting.items.some((item: any) => item.messageId)), { what: "the question" });
    const items = (updated.event as any).waiting.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ botId, messageId: expect.any(String) });
  });

  it("the main bot's head may read and write every bot's notes (--add-dir)", async () => {
    const dir = tempDir("adddir");
    const folder = project("Notes");
    const first = core(dir);
    await first.call({ type: "projects.add", folder });
    await first.kill();
    const c = core(dir, { FAKE_CLAUDE_ARGS: join(dir, "args.log") });
    await reply(c, MAIN, "hi");
    const started = logged(join(dir, "args.log"));
    const main = started.find((line) => line.args.includes("--add-dir"));
    const dirs = main.args.flatMap((arg: string, index: number) => (main.args[index - 1] === "--add-dir" ? [arg] : []));
    expect(dirs).toEqual([join(folder, ".bot"), join(dir, "plugins", ".bot")]);
    // Only the main bot gets them.
    expect(started.filter((line) => line.args.includes("--add-dir"))).toHaveLength(1);
  });
});
