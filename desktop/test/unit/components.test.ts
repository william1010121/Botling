// The component pieces on their own: what a bot is told (one line per component), about.md's lines, a command's run (JSON or text, its limits,
// its whole process group ended), the Detail command's values, pins' chip lines, and pictures.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aboutLine, aboutSizes, ComponentLibrary, componentKnowledgeFor, knowledgeChanges, knowledgeFull, refreshSeconds, safeName, spelledSize } from "../../src/core/components/library";
import { ComponentCommands, dataFromOutput, detailCommandLine, detailValues, execute, placeholders } from "../../src/core/components/commands";
import { ImageRegistry } from "../../src/core/components/service";
import { alive, pidsIn, sleep, tempDir, until } from "../helpers";

process.env.BOTLING_PLAIN_SHELL = "1";

// Before the prompt slimming (audit 2026-11-11) this matched Swift's ComponentKnowledge (prompts-golden.json
// "components"); now each component is one line with how it is filled, and its usage comes from app_component_usage.
describe("what a bot is told about components", () => {
  const told = { own: [{ name: "status", text: "- status (JSON): A status card." }, { name: "chart", text: "- chart (command): A chart." }], others: [{ name: "todo", text: "- todo: A todo list." }, { name: "gone", text: "- gone: Old." }], limit: 20 };
  const now = { own: [{ name: "status", text: "- status (JSON): A status card, red when failing." }, { name: "todo", text: "- todo (JSON): A todo list." }], others: [{ name: "chart", text: "- chart: A chart." }, { name: "weather", text: "- weather: Weather." }], limit: 20 };
  const header = "(App: Components in the chat: 2 / 20 yours, one line each below (a bot has at most 20). A (command) one fills itself from its own Command: <show name=\"name\"></show> is all it needs. A (JSON) one needs its JSON inside the tag, <show name=\"name\">JSON</show> (an empty one draws nothing; a \"Board command:\" is never run by the chat): call app_component_usage with its name for its data format and options before you fill it or use one of them. <show name=\"name\" command=\"git diff --stat\"></show> fills a card with what that command prints instead (run in your project folder once the user allows it; JSON output is used as the data, other output as one string; the card has a refresh button). Add refresh=\"2s\" to rerun a command card every 2 seconds while it is on screen (a component whose usage says \"Refresh: every 2s\" does so already). Give a card an id, <show name=\"name\" id=\"tests\">JSON</show>, and a later <show> with the same id updates that card in place instead of adding a new one when it is all your reply holds (for progress you keep up to date); with words it moves the card under them. Cards may keep state the user changes (ccb.save); you get it with the user's next message. <component name=\"name\">request</component> asks Maintainer to change one, make a new one, or give you one from the shared library.)";
  const shelf = "(App: Also in the shared library, not yours yet, one line each. To use one, ask Maintainer for it with <component name=\"name\">add it to my list</component>; it then shows up in your list.)";
  it("in full, and only what changed", () => {
    expect(knowledgeFull(told)).toBe(`${header}\n- status (JSON): A status card.\n- chart (command): A chart.\n${shelf}\n- todo: A todo list.\n- gone: Old.`);
    expect(knowledgeFull({ ...told, others: [] })).toBe(`${header}\n- status (JSON): A status card.\n- chart (command): A chart.`);
    expect(knowledgeChanges(now, told)).toBe("(App: Components were updated; only what changed since you were last told, the rest is as before. You have 2 / 20.)\nNew on your list:\n- todo (JSON): A todo list.\nChanged (this replaces what you had):\n- status (JSON): A status card, red when failing.\nNo longer yours (still in the shared library; ask Maintainer to get one back):\n- chart: A chart.\nGone from the library: gone\nNew or changed in the shared library, not yours yet:\n- weather: Weather.");
    expect(knowledgeChanges(told, told)).toBeNull();
  });
});

describe("the library", () => {
  it("reads about.md's lines, sizes, refresh and icon; the catalog has each usage indented", () => {
    const about = "Clock card：the time.\n- Command: `date +%H:%M`\nDetail command: git show {hash}\nRefresh: every 2s\nSizes: 1x1, 2×1, huge, wide\nIcon: 🕐";
    expect(aboutLine(about, "command:")).toBe("date +%H:%M");
    expect(aboutLine(about, "detail command:")).toBe("git show {hash}");
    expect(aboutSizes(about)).toEqual(["1x1", "2x1"]);
    expect(aboutSizes("nothing")).toEqual(["2x2"]);
    expect(refreshSeconds("every 2s")).toBe(2);
    expect(refreshSeconds("500ms")).toBe(1);
    expect(refreshSeconds("3 min")).toBe(180);
    expect(refreshSeconds("2h")).toBeNull();
    expect(refreshSeconds("off")).toBeNull();
    expect(spelledSize("M")).toBe("2x2");
    expect(spelledSize("5x1")).toBeNull();
    expect(safeName("My Card!")).toBe("my-card");
    const root = join(tempDir("library"), "components");
    mkdirSync(join(root, "clock"), { recursive: true });
    writeFileSync(join(root, "clock", "template.html"), "<div>clock</div>");
    writeFileSync(join(root, "clock", "about.md"), about);
    const library = new ComponentLibrary(() => [root]);
    expect(library.names).toEqual(["clock"]);
    expect(library.catalog(["clock"])).toBe("- clock: Clock card：the time.\n  - Command: `date +%H:%M`\n  Detail command: git show {hash}\n  Refresh: every 2s\n  Sizes: 1x1, 2×1, huge, wide\n  Icon: 🕐");
    expect(library.summaries(["clock"])).toBe("- clock: Clock card：the time.");
    // One line each, marked by how it is filled; the rest of about.md is not sent; choices is never listed (audit 2026-11-11).
    writeFileSync(join(root, "clock", "about.md"), `${about}\n\n## Data format\n\nLong builder details.`);
    mkdirSync(join(root, "choices"), { recursive: true });
    writeFileSync(join(root, "choices", "template.html"), "<b>choices</b>");
    writeFileSync(join(root, "choices", "about.md"), "Buttons.\n## Look\nLong.");
    mkdirSync(join(root, "table"), { recursive: true });
    writeFileSync(join(root, "table", "template.html"), "<table></table>");
    writeFileSync(join(root, "table", "about.md"), "A table.\n## Data format\nrows");
    library.rescan();
    const k = componentKnowledgeFor(library, ["choices", "clock", "table"]);
    expect(k.own).toEqual([{ name: "clock", text: "- clock (command): Clock card：the time." }, { name: "table", text: "- table (JSON): A table." }]);
    expect(k.others).toEqual([]);
    for (const name of ["choices", "table"]) rmSync(join(root, name), { recursive: true });
    writeFileSync(join(root, "clock", "about.md"), about);
    library.rescan();
    expect(library.info("clock")).toMatchObject({ template: "<div>clock</div>", version: 0, sizes: ["1x1", "2x1"], icon: "🕐", title: "Clock card" });
    expect(library.refreshInterval("clock")).toBe(2);
    // A new folder, a changed template, a changed about.md.
    mkdirSync(join(root, "note"), { recursive: true });
    writeFileSync(join(root, "note", "template.html"), "<p>note</p>");
    expect(library.rescan()).toBe(true);
    expect(library.names).toEqual(["clock", "note"]);
    writeFileSync(join(root, "clock", "template.html"), "<div>clock 2</div>", { flag: "w" });
    const later = Date.now() / 1000 + 5;
    require("node:fs").utimesSync(join(root, "clock", "template.html"), later, later);
    expect(library.rescan()).toBe(false);
    expect(library.info("clock")).toMatchObject({ version: 1, updated: true });
  });
});

describe("a component's command", () => {
  it("gives JSON as it is and other output as one string; failures say why", async () => {
    const folder = tempDir("command");
    expect(await execute(`printf '{"a": 1}'`, folder)).toMatchObject({ data: `{"a": 1}` });
    expect(await execute("echo hello/there", folder)).toMatchObject({ data: `"hello/there"` });
    expect(dataFromOutput("[1,2]\n")).toBe("[1,2]");
    expect((await execute("echo oops >&2; exit 4", folder)).error).toBe("The command failed (exit code 4).\noops");
    expect((await execute("ls", join(folder, "missing"))).error).toBe(`The project folder ${join(folder, "missing")} is not there.`);
    expect((await execute("yes | head -c 3000", folder, 5_000, 1_000)).error).toBe("The command printed more than 1 KB, so it was stopped.");
  });

  it("is stopped at its time limit, with everything it started", async () => {
    const folder = tempDir("command");
    const pids = join(folder, "pids");
    const started = Date.now();
    const outcome = await execute(`sleep 30 & echo $! >> ${pids}; echo $$ >> ${pids}; sleep 30`, folder, 600);
    expect(outcome).toMatchObject({ timedOut: true, error: "The command took longer than 1 seconds, so it was stopped." });
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(() => pidsIn(pids).length === 2 && pidsIn(pids).every((pid) => !alive(pid)), { timeout: 5_000, what: "the command's group to be gone" });
  });

  it("runs only once allowed for that folder, keeps each card's last run, and fills Detail commands with checked values only", async () => {
    const folder = tempDir("command");
    const commands = new ComponentCommands(join(folder, "approved.json"));
    expect(commands.state("m/0", "echo 1", null, folder).status).toBe("approve");
    await commands.run("m/0", "echo 1", folder);
    expect(commands.state("m/0", "echo 1", null, folder).status).toBe("approve");
    commands.approve("echo 1", folder);
    expect(commands.state("m/0", "echo 1", "git show {hash}", folder).status).toBe("approve");
    expect(commands.state("m/0", "echo 1", null, folder).status).toBe("idle");
    await commands.run("m/0", "echo 1", folder);
    expect(commands.state("m/0", "echo 1", null, folder)).toMatchObject({ status: "done", data: "1" });
    // Another folder's card asks again.
    expect(commands.state("m/0", "echo 1", null, join(folder, "..")).status).toBe("approve");
    expect(JSON.parse(readFileSync(join(folder, "approved.json"), "utf8"))).toEqual({ [folder]: ["echo 1"] });
    expect(placeholders("git show {hash} {path} {hash}")).toEqual(["hash", "path"]);
    expect(detailCommandLine("git show {hash}", { hash: "2aed630" })).toEqual({ line: "git show '2aed630'" });
    expect(detailCommandLine("git show {hash}", {})).toEqual({ problem: "No value for {hash}." });
    expect(detailCommandLine("git show {hash}", { hash: "a b" })).toEqual({ problem: "The value for {hash} may only have letters, digits and . _ / -." });
    expect(detailCommandLine("git show {hash}", { hash: "x".repeat(201) })).toEqual({ problem: "The value for {hash} is longer than 200 characters." });
    expect(detailValues({ hash: "a", n: 3 })).toEqual({ hash: "a", n: "3" });
    expect(detailValues({ n: 1.5 })).toBeNull();
    expect(detailValues({ n: true })).toBeNull();
    expect(await commands.runDetail("printf %s {hash}", { hash: "x" }, folder)).toMatchObject({ error: expect.stringContaining("not allowed yet") });
    commands.approve("Detail command: printf %s {hash}", folder);
    expect(await commands.runDetail("printf %s {hash}", { hash: "x" }, folder)).toMatchObject({ data: `"x"` });
    // {save: true}: the output is the card's data, as its command's run.
    await commands.runDetail("printf %s {hash}", { hash: "y" }, folder, { card: "m/0", command: "echo 1" });
    expect(commands.state("m/0", "echo 1", null, folder)).toMatchObject({ status: "done", data: `"y"` });
    await sleep(10);
  });
});

describe("pictures", () => {
  it("serves only the pictures a component's data names, by token", () => {
    const folder = tempDir("pictures");
    const png = join(folder, "shot one.png");
    writeFileSync(png, "png");
    writeFileSync(join(folder, "notes.txt"), "text");
    const images = new ImageRegistry();
    const urls = images.urls(JSON.stringify({ shot: png, other: { list: [`file://${encodeURI(png)}`, join(folder, "notes.txt"), join(folder, "missing.png")] } }));
    expect(Object.keys(urls).sort()).toEqual([png, `file://${encodeURI(png)}`].sort());
    const token = urls[png]!.slice("botling-card://image/".length);
    expect(images.file(token)).toEqual({ path: require("node:fs").realpathSync(png), type: "image/png" });
    expect(images.file("0".repeat(40))).toBeNull();
    expect(images.urls(`"no slash"`)).toEqual({});
  });
});
