// The component pieces on their own: what a bot is told (checked string for string against the
// Swift app's ComponentKnowledge), about.md's lines, a command's run (JSON or text, its limits,
// its whole process group ended), the Detail command's values, pins' chip lines, and pictures.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aboutLine, aboutSizes, ComponentLibrary, knowledgeChanges, knowledgeFull, refreshSeconds, safeName, spelledSize } from "../../src/core/components/library";
import { ComponentCommands, dataFromOutput, detailCommandLine, detailValues, execute, placeholders } from "../../src/core/components/commands";
import { chip, headline, readPin, short } from "../../src/core/components/pins";
import { ImageRegistry } from "../../src/core/components/service";
import { alive, desktop, pidsIn, sleep, tempDir, until } from "../helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8")).components;
process.env.BOTLING_PLAIN_SHELL = "1";

describe("what a bot is told about components, as Swift writes it", () => {
  const told = { own: [{ name: "status", text: "- status: A status card.\n  Data: {\"ok\":true}" }, { name: "chart", text: "- chart: A chart." }], others: [{ name: "todo", text: "- todo: A todo list." }, { name: "gone", text: "- gone: Old." }], limit: 20 };
  const now = { own: [{ name: "status", text: "- status: A status card.\n  Data: {\"ok\":false}" }, { name: "todo", text: "- todo: A todo list.\n  Data: []" }], others: [{ name: "chart", text: "- chart: A chart." }, { name: "weather", text: "- weather: Weather." }], limit: 20 };
  it("in full, and only what changed", () => {
    expect(knowledgeFull(told)).toBe(golden.full);
    expect(knowledgeFull({ ...told, others: [] })).toBe(golden.fullNoOthers);
    expect(knowledgeChanges(now, told)).toBe(golden.changes);
    expect(knowledgeChanges(told, told)).toBe(golden.unchanged);
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

describe("pins and pictures", () => {
  it("say what a pin holds in a line, from its data's shape", () => {
    expect(headline(`{"summary":"All green","x":1}`)).toBe("All green");
    expect(headline(`{"items":[{"title":"a"},{"title":"b"}]}`)).toBe("a · 2");
    expect(headline(`{"cpu":42,"mem":7,"disk":1}`)).toBe("cpu 42 · mem 7");
    expect(headline(`[]`)).toBe("Nothing yet");
    expect(headline(`true`)).toBe("Yes");
    expect(headline("not json\nsecond")).toBe("not json");
    expect(short("a very long status text")).toBe("a very long s…");
    expect(chip(undefined, "x", "failed", true)).toEqual({ text: "Failed", tone: "bad" });
    expect(chip(undefined, "x", "approve", false)).toEqual({ text: "Allow?", tone: "warning" });
    expect(chip({ text: "26°", tone: "good" }, "x", "done", true)).toEqual({ text: "26°", tone: "good" });
    // 1.x's pins.json: old sizes and unknown values fall back; a pin without a command never refreshes.
    expect(readPin({ id: "A", name: "n", data: "1", refresh: "weekly", size: "L", minutes: 0, float: { corner: "x", width: 280, height: 160 } })).toMatchObject({ refresh: "manual", size: "4x2", minutes: 1, float: { corner: "topRight", collapsed: false } });
    expect(readPin({ name: "no id" })).toBeNull();
  });

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
