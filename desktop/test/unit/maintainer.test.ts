// Maintainer: its instructions, the component editor's agent file, PLUGINS.md, the library's own
// manifests and what it is told about the bot that asked, equal to the strings the Swift code wrote
// (prompts-golden.json "maintainer"); then through the built core: <component>, <plugin>, <give-component>,
// <component-declined> and a component landing in the library, and <install> asking the user first.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { CoreHarness, MAIN } from "../core-harness";
import golden from "../fixtures/prompts-golden.json";
import { componentEditorAgent, maintainerInstructions, pluginGuide } from "../../src/core/maintainer-text";
import { MaintainerDesk, arrivalLead, classifySource, prepareLibrary } from "../../src/core/maintainer";
import { ComponentLibrary } from "../../src/core/components/library";

const M = (golden as unknown as { maintainer: Record<string, any> }).maintainer;
const MAINTAINER = "DEC0DE00-0000-4000-8000-00000000DEC0";

describe("Maintainer's strings, as the Swift app wrote them", () => {
  it("instructions (with and without check and component-shot commands), the editor agent, PLUGINS.md", () => {
    expect(maintainerInstructions(M.library, null, null)).toBe(M.instructions);
    expect(maintainerInstructions(M.libraryTooled, "CHECK-COMMAND", "SHOT-COMMAND")).toBe(M.instructionsTooled);
    expect(componentEditorAgent("sonnet")).toBe(M.editorAgentSonnet);
    expect(componentEditorAgent("opus")).toBe(M.editorAgentOpus);
    expect(pluginGuide()).toBe(M.pluginGuide);
    expect(arrivalLead("todo", false)).toBe(M.arrivalLead);
    expect(arrivalLead("status", true)).toBe(M.arrivalLeadChanged);
  });

  it("the library's own files: ccb-components, ccb-core (the editor follows the app unless edited), PLUGINS.md", () => {
    const root = tempDir("maintainer");
    expect(prepareLibrary(root)).toEqual({ editedEditor: false });
    const library = join(root, "plugins");
    expect(readFileSync(join(library, "ccb-components", "package.json"), "utf8")).toBe(M.componentsManifest);
    expect(readFileSync(join(library, "ccb-core", "package.json"), "utf8")).toBe(M.coreManifest);
    expect(readFileSync(join(library, "ccb-core", "claude", ".claude-plugin", "plugin.json"), "utf8")).toBe(M.coreClaudeManifest);
    const editor = join(library, "ccb-core", "claude", "agents", "component-editor.md");
    expect(readFileSync(editor, "utf8")).toBe(M.editorAgentSonnet);
    expect(readFileSync(join(library, "PLUGINS.md"), "utf8")).toBe(M.pluginGuide);
    // Another model: the app's own file follows; an edited one stays.
    prepareLibrary(root, "opus");
    expect(readFileSync(editor, "utf8")).toBe(M.editorAgentOpus);
    writeFileSync(editor, M.editorAgentOpus + "- A rule of Maintainer's.\n");
    expect(prepareLibrary(root, "haiku")).toEqual({ editedEditor: true });
    expect(readFileSync(editor, "utf8")).toContain("A rule of Maintainer's.");
  });

  it("what Maintainer is told about the bot that asked (componentAskNote)", () => {
    const root = tempDir("maintainer");
    const folder = join(root, "plugins", "ccb-components", "components");
    for (const name of ["status", "chart", "todo"]) {
      mkdirSync(join(folder, name), { recursive: true });
      writeFileSync(join(folder, name, "template.html"), `<div>${name}</div>`);
      writeFileSync(join(folder, name, "about.md"), `A ${name} card.\n`);
    }
    const library = new ComponentLibrary(() => [folder]);
    let list: string[] = ["status"];
    const sent: string[] = [];
    const bot = {
      id: MAIN, profile: { name: "Main bot" },
      get components() { return list; },
      get ownComponentNames() { return library.names.filter((name) => list.includes(name)); },
      lastAsked: "Show me my todos please",
      setComponentList(names: string[]) { list = names; },
      appMessage(text: string) { sent.push(text); },
      appNotice(text: string) { sent.push(`notice: ${text}`); return "n"; },
    } as never;
    const desk = new MaintainerDesk({ root, maintainer: () => null, mainBot: () => bot, bots: () => [bot], library, plugins: () => null, log: () => {} });
    const key = (text: string) => text.replace(/id="[0-9a-f]{8}"/g, 'id="KEY"');
    expect(key(desk.askNote("status", "make it blue", true, bot))).toBe(M.askNotes.changing);
    expect(key(desk.askNote("todo", "a todo list", true, bot))).toBe(M.askNotes.given);
    expect(key(desk.askNote("weather", "the weather", false, bot))).toBe(M.askNotes.new);
    // Given at once: the bot is woken to answer with it, and the chat says so.
    expect(sent[0]).toBe(`(App: Maintainer added the component "todo" to your list (your request: a todo list). The user had asked you: "Show me my todos please". Answer that now: draw it with <show name="todo">…</show> as its usage says, with one short sentence in the user's language. Do not ask Maintainer for it again.)\n- todo: A todo card.`);
    expect(sent[1]).toBe("notice: Maintainer added todo to your components.");
  });

  it("knows what a source is (PluginInstaller.classify)", () => {
    const root = tempDir("maintainer");
    expect(classifySource(root)).toEqual({ kind: "folder", path: root });
    expect(classifySource(join(root, "missing"))).toBeNull();
    expect(classifySource("https://github.com/a/b.git")).toEqual({ kind: "git", url: "https://github.com/a/b.git" });
    expect(classifySource("git@github.com:a/b.git")).toEqual({ kind: "git", url: "git@github.com:a/b.git" });
    expect(classifySource("https://x.org/p.zip")).toEqual({ kind: "archive", url: "https://x.org/p.zip" });
    expect(classifySource("@scope/name@1.2")).toEqual({ kind: "npm", name: "@scope/name@1.2" });
    expect(classifySource("not a source!")).toBeNull();
  });
});

describe("Maintainer in the core", () => {
  const harnesses: CoreHarness[] = [];
  afterEach(async () => { for (const harness of harnesses.splice(0)) if (harness.child.exitCode === null) await harness.kill("SIGTERM"); });
  function core(dir: string) {
    const harness = new CoreHarness(dir, {
      BOTLING_COMPONENT_SCAN_MS: "150", FAKE_CLAUDE_INPUT: join(dir, "claude-input.log"), FAKE_CLAUDE_LOG: join(dir, "claude-start.log"),
      // git for the library, without the user's own git settings.
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    });
    harnesses.push(harness);
    return harness;
  }
  const lines = (file: string): any[] => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  async function say(c: CoreHarness, botId: string, text: string) {
    // A job the app handed over first gets its answer (a message now would join it, as 1.x merges parts).
    await until(async () => { const chat = await c.chat(botId); return !chat.running && !chat.messages.some((m: any) => m.state === "streaming"); });
    const { turnId } = await c.call({ type: "chat.send", botId, text });
    await until(() => c.of("turn.finished").find((e: any) => e.event.turnId === turnId), { what: `turn ${turnId}` });
  }
  function component(dir: string, name: string, about: string) {
    const folder = join(dir, "plugins", "ccb-components", "components", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "template.html"), `<div>${name}</div>`);
    writeFileSync(join(folder, "about.md"), about);
  }

  it("is in the left column with the library as its folder, 1.x's instructions and the component editor (--plugin-dir)", async () => {
    const dir = tempDir("maintainer");
    const c = core(dir);
    const bots = (await c.call({ type: "chat.snapshot" })).bots;
    expect(bots.at(-1)).toMatchObject({ id: MAINTAINER, name: "Maintainer", role: "manager", avatar: "diamond", folder: join(dir, "plugins") });
    await say(c, MAINTAINER, "hello");
    const start = lines(join(dir, "claude-start.log")).at(-1);
    expect(start.cwd).toBe(join(dir, "plugins"));
    const args: string[] = start.args;
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(join(dir, "plugins", "ccb-core", "claude"));
    const system = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(system).toContain(`- You are "Maintainer": you look after the plugin library of the Botling app. Your working folder ${join(dir, "plugins")} is the plugin library, a git repo.`);
    // The check command 2.0 gives it runs the same checks the app does.
    const check = /Run the check: (.+) <plugin folder>\./.exec(system)![1]!;
    const out = execFileSync("/bin/sh", ["-c", `${check} ${join(dir, "plugins", "ccb-core")}`], { encoding: "utf8" });
    expect(out).toMatch(/passes the checks/);
  });

  it("<component>: a new one goes to Maintainer with who asked; it lands in the library and the bot gets it; a decline goes back", async () => {
    const dir = tempDir("maintainer");
    component(dir, "status", "Status card: whether it is OK.\nData: {\"ok\":true}");
    const c = core(dir);
    await say(c, MAIN, "/say I'll ask for one. <component name=\"weather\">a weather card for today</component>");
    // No "cannot do this yet" notice any more.
    expect((await c.chat()).messages.some((m: any) => m.text.includes("cannot do this yet"))).toBe(false);
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"));
    expect(relay.text).toMatch(/^Main bot wants a new component "weather": a weather card for today \(App: Main bot has 0 \/ 20 components\. Check the library first: if a component there already does this, build nothing and reply with <give-component bot="Main bot">its name<\/give-component>\. Otherwise build it; once it is in the library the app adds it to Main bot's list\. If you will not or cannot do it, say why and end your reply with <component-declined id="[0-9a-f]{8}">why, in one sentence for Main bot<\/component-declined>; the app passes it on to Main bot\.\)$/);
    await until(() => lines(join(dir, "claude-input.log")).some((entry) => entry.text.includes("(From the main bot) Main bot wants a new component \"weather\"")));
    // The library is a git repo now (made before the first job).
    expect(existsSync(join(dir, "plugins", ".git"))).toBe(true);
    // Maintainer built it: it lands in the library; the main bot gets it on its list and is woken to answer with it.
    component(dir, "weather", "Weather card: today's weather.\nData: {\"sky\":\"sun\"}");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "Maintainer added Weather card (weather) to your components."), { timeout: 10_000 });
    expect(JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components).toEqual(["weather"]);
    await until(() => lines(join(dir, "claude-input.log")).some((entry) => entry.text.includes("(App: Maintainer added the component \"weather\" to your list (your request: a weather card for today).")));
    // A request Maintainer declines goes back to the bot, with why.
    await say(c, MAIN, "/say <component name=\"radar\">a rain radar</component>");
    const ask = await until(async () => (await c.chat(MAINTAINER)).messages.filter((m: any) => m.role === "relay").find((m: any) => m.text.includes('"radar"')));
    const key = /component-declined id="([0-9a-f]{8})"/.exec(ask.text)![1];
    await say(c, MAINTAINER, `/say There is no radar source. <component-declined id="${key}">No radar data source is available.</component-declined>`);
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "Maintainer did not add radar: No radar data source is available."));
    await until(() => lines(join(dir, "claude-input.log")).some((entry) => entry.text.startsWith('(App: Maintainer did not add the component "radar" you asked for. Maintainer said: "No radar data source is available.".')));
  });

  it("a card's report and change request reach Maintainer with the pictures (1.x's reportComponentProblem); Revert puts back the version before (git)", async () => {
    const dir = tempDir("maintainer");
    component(dir, "test", "A plain test card.");
    const c = core(dir);
    const phase5 = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "phase5-golden.json"), "utf8")).more.reports;
    // A change asked from the card's menu, with words only: 1.x's request, word for word; it shows as being worked on.
    expect(await c.call({ type: "component.report", botId: MAIN, name: "test", text: "Make it blue", images: [], rect: null, problem: false })).toEqual({ sent: true });
    const first = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"));
    expect(first.text).toBe(phase5.relays[0].text);
    await until(async () => (await c.call({ type: "chat.snapshot" })).components.test?.working === true);
    // Pictures only: they go along as the relay's attachments, and the head reads their paths.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await c.call({ type: "component.report", botId: MAIN, name: "test", text: "", images: [{ name: "look.png", base64: png }], rect: null, problem: false });
    const second = await until(async () => (await c.chat(MAINTAINER)).messages.filter((m: any) => m.role === "relay")[1]);
    expect(second.text).toBe(phase5.relays[1].text);
    expect(second.attachments).toHaveLength(1);
    await until(() => lines(join(dir, "claude-input.log")).some((entry) => entry.text.includes("see the attached picture (Attached: a picture") && entry.text.includes(join(dir, "plugins", ".bot", "attachments"))));
    // "Report a problem…": the card's chat, and nothing at all without words or a picture.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    expect(await c.call({ type: "component.report", botId: MAIN, name: "test", text: "  ", images: [], rect: null, problem: true })).toEqual({ sent: false });
    await c.call({ type: "component.report", botId: MAIN, name: "test", text: "It is cut off", images: [], rect: null, problem: true });
    const third = await until(async () => (await c.chat(MAINTAINER)).messages.filter((m: any) => m.role === "relay")[2]);
    expect(third.text).toBe(`The user's request for the component "test": Problem reported from the card in Main bot's chat: It is cut off`);
    // Its Maintainer's turn ended: no longer worked on. The library is a repo; a hand edit can be reverted.
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await until(async () => (await c.call({ type: "chat.snapshot" })).components.test?.working === false);
    const template = join(dir, "plugins", "ccb-components", "components", "test", "template.html");
    writeFileSync(template, "<div>changed by hand</div>");
    await until(async () => (await c.call({ type: "chat.snapshot" })).components.test?.hasPrevious === true, { what: "an earlier version" });
    expect(await c.call({ type: "component.revert", name: "test" })).toEqual({ reverted: true, problem: null });
    expect(readFileSync(template, "utf8")).toBe("<div>test</div>");
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: join(dir, "plugins"), encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    expect(log.split("\n").slice(0, 2)).toEqual(["Revert component test to the previous version", "component test: uncommitted changes (saved automatically before reverting)"]);
    // One with no history says so in the main bot's chat.
    expect(await c.call({ type: "component.revert", name: "nothing-here" })).toEqual({ reverted: false, problem: "This component has no version history." });
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === 'Couldn\'t revert component "nothing-here": This component has no version history.'));
  });

  it("<component> for one already in the library goes on the list at once; <give-component> and <take-component>; <plugin>", async () => {
    const dir = tempDir("maintainer");
    component(dir, "status", "Status card: whether it is OK.");
    component(dir, "todo", "Todo list.");
    const c = core(dir);
    await say(c, MAIN, "/say <component name=\"status\">show my status</component>");
    await until(async () => (await c.chat()).messages.some((m: any) => m.role === "notice" && m.text === "Maintainer added Status card (status) to your components."));
    const relay = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "relay"));
    expect(relay.text).toBe(`Main bot's request for the component "status": show my status (App: "status" is already in the library, so the app added it to Main bot's list and told Main bot; nothing to build. Change it only if the request asks for a change.)`);
    await say(c, MAINTAINER, "/say Here you go. <give-component bot=\"Main bot\">todo</give-component>");
    await until(() => JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components?.includes("todo"));
    await say(c, MAINTAINER, "/say <take-component bot=\"main bot\">status</take-component>");
    await until(() => !JSON.parse(readFileSync(join(dir, "main", "bot.json"), "utf8")).components.includes("status"));
    await say(c, MAIN, "/say Asking. <plugin>a word counter in the input box</plugin>");
    await until(async () => (await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay" && m.text === "Main bot's request for Botling: a word counter in the input box"));
  });

  it("<need-folder>: you are asked once in Maintainer's chat; allowed, it reads the folder (--add-dir, same session); a folder inside is allowed at once", async () => {
    const dir = tempDir("maintainer");
    const outside = tempDir("outside-folder");
    const c = core(dir);
    await say(c, MAINTAINER, `/say To turn it into a plugin I need to read it. <need-folder>${outside}/</need-folder>`);
    const question = await until(async () => (await c.chat(MAINTAINER)).messages.find((m: any) => m.role === "notice" && m.choices?.length));
    expect(question.text).toBe(`Maintainer wants to read "${outside}". It will only read, never change files there. Allow it?`);
    expect(question.choices.map((choice: any) => [choice.label, choice.detail ?? null])).toEqual([["Allow", "Won't ask again"], ["Don't allow", null]]);
    const before = lines(join(dir, "claude-start.log")).at(-1);
    expect(before.args).not.toContain(outside);
    expect(await c.call({ type: "chat.choose", botId: MAINTAINER, messageId: question.id, index: 0 })).toEqual({ accepted: true });
    expect(JSON.parse(readFileSync(join(dir, "folders.json"), "utf8"))).toEqual([outside]);
    const agreed = `(App) The user agreed: you can now read ${outside} (read only, do not change files there). Carry on with what you were doing.`;
    await until(async () => (await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay" && m.text === agreed));
    // Its process started again before that message, in the same session, with the folder.
    const after = await until(() => lines(join(dir, "claude-start.log")).find((start) => start.args.includes(outside)), { what: "a start with the folder" });
    expect(after.pid).not.toBe(before.pid);
    expect(after.session).toBe(before.session);
    expect(after.resume).toBe(true);
    expect(after.args[after.args.indexOf(outside) - 1]).toBe("--add-dir");
    await until(async () => !(await c.chat(MAINTAINER)).running);
    // Inside a folder allowed before: at once.
    await say(c, MAINTAINER, `/say <need-folder>${outside}/src</need-folder>`);
    await until(async () => (await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay" && m.text === `(App) ${join(outside, "src")} was already allowed before; you can read it directly.`));
    // Don't allow: told so, nothing kept.
    const other = tempDir("outside-other");
    await until(async () => !(await c.chat(MAINTAINER)).running);
    await say(c, MAINTAINER, `/say <need-folder>${other}</need-folder>`);
    const second = await until(async () => (await c.chat(MAINTAINER)).messages.findLast((m: any) => m.role === "notice" && m.choices?.length && m.chosen == null));
    await c.call({ type: "chat.choose", botId: MAINTAINER, messageId: second.id, index: 1 });
    await until(async () => (await c.chat(MAINTAINER)).messages.some((m: any) => m.role === "relay" && m.text === `(App) The user did not allow you to read ${other}. Find another way, or explain that it can't be done.`));
    expect(JSON.parse(readFileSync(join(dir, "folders.json"), "utf8"))).toEqual([outside]);
    // Only Maintainer asks for folders: anyone else's tag is left alone (1.x), no notice.
    await say(c, MAIN, `/say <need-folder>${other}</need-folder>`);
    expect((await c.chat()).messages.some((m: any) => m.role === "notice" && /folder/.test(m.text))).toBe(false);
  });

  it("<install> asks the user first; only Install puts it into the library (committed); a plugin that fails the checks is not offered", async () => {
    const dir = tempDir("maintainer");
    const source = join(tempDir("outside"), "counter");
    mkdirSync(join(source, "dist"), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "counter", displayName: "Word counter", version: "0.3.0", description: "Counts words.", license: "MIT", author: { name: "Ada" }, engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ["composer"] } }));
    writeFileSync(join(source, "dist", "host.mjs"), "export function activate() {}\n");
    const bad = join(tempDir("outside"), "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "package.json"), JSON.stringify({ name: "bad", version: "1.0.0", engines: { ccb: "^9.0.0" }, ccb: {} }));
    const c = core(dir);
    await say(c, MAIN, `/say I'll ask. <install>${source}</install>`);
    const question = await until(async () => (await c.chat()).messages.find((m: any) => m.role === "notice" && m.choices?.length));
    expect(question.text).toBe(`Install the plugin "Word counter" 0.3.0?\nCounts words.\nSource: ${source}\nAuthor: Ada; license: MIT\nIt will: read and change what you type in the input box\nIt has a program part that runs on your computer (permissions are only declared, not sandboxed).`);
    expect(question.choices.map((choice: any) => choice.label)).toEqual(["Install", "Don't install"]);
    expect(existsSync(join(dir, "plugins", "counter"))).toBe(false);
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: question.id, index: 0 })).toEqual({ accepted: true });
    await until(async () => (await c.chat()).messages.some((m: any) => m.text === "Installed: Word counter 0.3.0. You can turn it off under Plugins (the header's Plugins button)."));
    expect(readFileSync(join(dir, "plugins", "counter", "dist", "host.mjs"), "utf8")).toContain("activate");
    expect((await c.call({ type: "plugins.list" })).plugins.find((p: any) => p.name === "counter")).toMatchObject({ installedFrom: source, enabled: true });
    const log = execFileSync("git", ["log", "--format=%s", "-n", "1"], { cwd: join(dir, "plugins"), encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    expect(log.trim()).toBe(`Install counter 0.3.0 (${source})`);
    expect(readFileSync(join(dir, "plugins.json"), "utf8")).toContain(source.replaceAll("/", "\\/"));
    // The staging copy is gone.
    expect(existsSync(join(dir, "install-staging")) ? require("node:fs").readdirSync(join(dir, "install-staging")) : []).toEqual([]);
    // Failing checks: said, not offered.
    await say(c, MAIN, `/say <install>${bad}</install>`);
    await until(async () => (await c.chat()).messages.some((m: any) => m.text.startsWith('"bad" failed the checks and was not installed: engines.ccb "^9.0.0" is not compatible')));
    // Don't install: nothing happens.
    await say(c, MAIN, `/say <install>${source}</install>`);
    const second = await until(async () => (await c.chat()).messages.findLast((m: any) => m.role === "notice" && m.choices?.length && m.chosen == null));
    expect(await c.call({ type: "chat.choose", botId: MAIN, messageId: second.id, index: 1 })).toEqual({ accepted: true });
    // A restart closes an open install question: nobody waits for it.
    await say(c, MAIN, `/say <install>${source}</install>`);
    const third = await until(async () => (await c.chat()).messages.findLast((m: any) => m.role === "notice" && m.choices?.length && m.chosen == null && m.answer == null));
    await c.kill("SIGTERM");
    const again = core(dir);
    const closed = (await again.chat()).messages.find((m: any) => m.id === third.id);
    expect(closed.answer).toBe("No longer needed");
  });
});
