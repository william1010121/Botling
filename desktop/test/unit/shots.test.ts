// Component shots (1.x's ComponentShot.swift): the usage, the command line, where the data comes from,
// the Command check, `judge`, `isUniform` and `summary`, equal character for character to what the
// Swift code wrote (test/fixtures/phase5-golden.json `more.shots`, made by
// Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALL_SIZES, DEFAULT_SURFACES, FLAG, HELP, LOOKS, PROBE_SCRIPT, TILE_CELL, TILE_GAP, USAGE, checkCommand, commandFolder, fileName, isRequested, isUniform, judge, notDrawn, parse, resolveData, sampleData,
  shotSizes, sourceText, summary, tileLayout, tilePixels, wantsHelp, withProbe, type DataSource, type FrameReport,
} from "../../src/core/component-shot";
import { SHOT_PLUGIN, shotPluginFile, shotWebSpecs } from "../../src/core/shot-plugins";
import { shotWorkerRule } from "../../src/core/prompts/delegation";
import { claudeWorkerPolicy } from "../../src/core/agent/claude-workers";
import { claudeHarness } from "../claude-workers-fake";
import { SHOT_JS } from "../../src/main/shot";
import { maintainerInstructions, componentEditorAgent } from "../../src/core/maintainer-text";
import { tempDir } from "../helpers";

process.env.BOTLING_PLAIN_SHELL = "1";
const golden = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "phase5-golden.json"), "utf8")).more.shots;

/** A component folder with a template (and an about.md). */
function component(folder: string, about: string | null) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "template.html"), "<div>card</div>");
  if (about !== null) writeFileSync(join(folder, "about.md"), about);
}

describe("component shots (ComponentShot.swift)", () => {
  it("has 1.x's flag and usage", () => {
    expect(FLAG).toBe(golden.flag);
    expect(USAGE).toBe(golden.usage);
    expect(isRequested(["electron", ".", "--component-shot", "x"])).toBe(true);
    expect(isRequested(["electron", "."])).toBe(false);
  });

  it("reads the command line as 1.x", () => {
    const base = tempDir("shots-parse");
    component(join(base, "comp"), "A card.");
    const now = Date.now();
    const place = (text: string) => text.replaceAll(base, "<root>");
    for (const entry of golden.parse) {
      const argv = (entry.arguments as string[]).map((text) => text.replaceAll("<root>", base));
      const result = parse(argv, base, now);
      if (entry.error !== undefined) {
        expect(result.ok, JSON.stringify(entry.arguments)).toBe(false);
        if (!result.ok) expect(place(result.error.message)).toBe(entry.error);
        continue;
      }
      expect(result.ok, JSON.stringify(entry.arguments)).toBe(true);
      if (!result.ok) continue;
      const { options } = result;
      const out = options.out === resolve(tmpdir(), `ccb-shot-comp-${Math.floor(now / 1000)}`) ? "<default>" : place(options.out);
      expect({ ...options, component: place(options.component), out, data: options.data && place(options.data), folder: options.folder && place(options.folder) }, JSON.stringify(entry.arguments))
        .toEqual(entry.options);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("finds about.md's example, the sizes and the Command's folder as 1.x", () => {
    for (const entry of golden.samples) expect(sampleData(entry.about), entry.about).toBe(entry.data);
    for (const entry of golden.sizes) expect(shotSizes(entry.asked, entry.hinted)).toEqual(entry.sizes);
    for (const entry of golden.commandFolders) expect(commandFolder(entry.component)).toBe(entry.folder);
    const sources: DataSource[] = [{ kind: "file", path: "/a/d.json" }, { kind: "command", command: "npm test --json" }, { kind: "example" }, { kind: "none" }];
    expect(sources.map(sourceText)).toEqual(golden.sources);
    expect(ALL_SIZES).toEqual(golden.parse.find((entry: { arguments: string[] }) => entry.arguments.includes("ALL")).options.sizes);
    for (const entry of golden.fileNames) expect(fileName(entry.place)).toBe(entry.file);
  });

  it("runs its Command once as written and says what failed as 1.x", async () => {
    const base = tempDir("shots-command");
    const place = (text: string) => text.replaceAll(base, "<root>");
    for (const entry of golden.commands) {
      const folder = join(base, `plug-${entry.label}`, "components", "card");
      component(folder, entry.command === null ? "A card.\n" : `A card.\nCommand: ${entry.command}\n`);
      const project = entry.folder === null ? null : join(base, entry.folder);
      if (entry.folder === "project") mkdirSync(project!, { recursive: true });
      const check = await checkCommand(folder, project, entry.timeout);
      if (entry.check === null) { expect(check, entry.label).toBeNull(); continue; }
      expect({
        command: check!.command, folder: place(check!.folder), data: check!.outcome.data ?? null, timedOut: !!check!.outcome.timedOut,
        findings: check!.findings.map((finding) => ({ ...finding, text: place(finding.text) })),
      }, entry.label).toEqual(entry.check);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("judges frames, pictures and writes the summary as 1.x", () => {
    for (const entry of golden.judge) {
      expect(judge(entry.report as FrameReport, entry.place, entry.uniform), entry.label).toEqual(entry.findings);
    }
    for (const entry of golden.uniform) {
      expect(isUniform(new Uint8Array(Buffer.from(entry.pixels, "base64"))), entry.label).toBe(entry.uniform);
    }
    const sources: Record<string, DataSource> = {
      [golden.sources[0]]: { kind: "file", path: "/a/d.json" }, [golden.sources[1]]: { kind: "command", command: "npm test --json" },
      [golden.sources[2]]: { kind: "example" }, [golden.sources[3]]: { kind: "none" },
    };
    for (const entry of golden.summaries) {
      // (The Swift run named the command it drew with in the summary's own first line.)
      const ran = /data from its Command \((.*)\)\)\./.exec(entry.text)?.[1];
      const source = ran ? { kind: "command" as const, command: ran } : sources[entry.source]!;
      expect(summary(entry.component, source, entry.findings, entry.shots, entry.sheet, entry.notes), entry.label).toBe(entry.text);
    }
    expect(notDrawn("chat", "null").text).toBe(golden.summaries.find((entry: { label: string }) => entry.label === "none").findings[0].text);
    expect(notDrawn("chat", "{}").level).toBe("problem");
  });

  it("takes the data from --data, its Command in --folder, about.md's example, else null", async () => {
    const base = tempDir("shots-data");
    const folder = join(base, "plug", "components", "card");
    component(folder, 'A card.\nData: {"from": "example"}\nCommand: echo \'{"from": "command"}\'\n');
    const options = (more: Record<string, unknown>) => ({ component: folder, out: join(base, "out"), data: null, folder: null, surfaces: [], sizes: null, theme: "dark", ...more } as never);
    const example = await resolveData(options({}));
    expect(example).toMatchObject({ data: '{"from": "example"}', source: { kind: "example" },
      notes: [`Its Command ran as written in ${join(base, "plug")}.`, "It has a Command; pass --folder <project> to draw what the command prints."] });
    mkdirSync(join(base, "project"));
    expect(await resolveData(options({ folder: join(base, "project") }))).toMatchObject({ data: '{"from": "command"}', source: { kind: "command" } });
    writeFileSync(join(base, "d.json"), ' {"from": "file"}\n');
    expect(await resolveData(options({ data: join(base, "d.json") }))).toMatchObject({ data: '{"from": "file"}', source: { kind: "file" } });
    writeFileSync(join(base, "bad.json"), "{nope");
    expect(await resolveData(options({ data: join(base, "bad.json") }))).toEqual({ error: `${join(base, "bad.json")} is not JSON.` });
    const bare = join(base, "bare");
    component(bare, null);
    expect(await resolveData(options({ component: bare }))).toMatchObject({ data: "null", source: { kind: "none" }, notes: [], findings: [] });
    rmSync(base, { recursive: true, force: true });
  });

  it("puts the probe first in a component page's head, and nowhere else", () => {
    const page = '<!doctype html><html data-size="2x2" data-surface="chat"><head><meta charset="utf-8"></head><body><div id="ccb-root"></div></body></html>';
    const probed = withProbe(page);
    expect(probed.startsWith('<!doctype html><html data-size="2x2" data-surface="chat"><head><script>(() => {')).toBe(true);
    expect(probed).toContain(PROBE_SCRIPT);
    expect(withProbe("<html><head></head><body>panel</body></html>")).toBe("<html><head></head><body>panel</body></html>");
  });

  it("gives Maintainer 1.x's shot line when there is a command, and the editor always its shot check", () => {
    const instructions = maintainerInstructions("/lib", "check", "'/Apps/Botling 2' --component-shot");
    expect(instructions).toContain("  Component shot: '/Apps/Botling 2' --component-shot <component folder> --out <new folder> draws a component");
    expect(maintainerInstructions("/lib", "check", null)).toContain("(No component-shot command this time: review the template by reading it.)");
    expect(componentEditorAgent()).toContain("- Check it as the app draws it: when your job gives a component-shot command, run it with Bash");
  });

  it("takes --theme dark|light, and says what else is not one", () => {
    const base = tempDir("shots-theme");
    component(join(base, "comp"), "A card.");
    const run = (...more: string[]) => parse(["botling", FLAG, "comp", ...more], base);
    const light = run("--theme", "Light");
    expect(light.ok && light.options.theme).toBe("light");
    const dark = run();
    expect(dark.ok && dark.options.theme).toBe("dark");
    const bad = run("--theme", "sepia");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("Unknown theme sepia: dark or light.");
    rmSync(base, { recursive: true, force: true });
  });

  it("--sizes draws the tile surface (alone it is added; beside --surfaces it must be named); a bare run has none", () => {
    const base = tempDir("shots-sizes");
    component(join(base, "comp"), "A card.");
    const run = (...more: string[]) => parse(["botling", FLAG, "comp", ...more], base);
    const bare = run();
    expect(bare.ok && bare.options.surfaces).toEqual([...DEFAULT_SURFACES]);
    expect(bare.ok && bare.options.surfaces).not.toContain("tile");
    const sized = run("--sizes", "1x1, 2×1,2x2,4x2,1x1");
    expect(sized.ok && sized.options.sizes).toEqual(["1x1", "2x1", "2x2", "4x2"]);
    expect(sized.ok && sized.options.surfaces).toEqual(["chat", "pinned", "floating", "tile"]);
    const all = run("--sizes", "all");
    expect(all.ok && all.options.sizes).toEqual(ALL_SIZES);
    const only = run("--surfaces", "tile");
    expect(only.ok && only.options).toMatchObject({ surfaces: ["tile"], sizes: null });
    expect(shotSizes(null, ["3x1"])).toEqual(["1x1", "2x1", "2x2", "4x2", "3x1"]);
    const both = run("--surfaces", "chat,tile", "--sizes", "2x2");
    expect(both.ok && both.options.surfaces).toEqual(["chat", "tile"]);
    const clash = run("--surfaces", "chat", "--sizes", "2x2");
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain("--sizes draws the tile surface");
    expect(run("--sizes", "5x5").ok).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });

  it("lays tiles out at their cell px, none over another and none past the width", () => {
    expect(tilePixels("1x1")).toEqual({ width: TILE_CELL, height: TILE_CELL });
    expect(tilePixels("4x2")).toEqual({ width: 4 * TILE_CELL + 3 * TILE_GAP, height: 2 * TILE_CELL + TILE_GAP });
    const layout = tileLayout(["1x1", "2x1", "2x2", "4x2", "4x4"], 1100, 28);
    expect(layout.tiles.map((tile) => tile.size)).toEqual(["1x1", "2x1", "2x2", "4x2", "4x4"]);
    for (const [index, a] of layout.tiles.entries()) {
      expect({ w: a.width, h: a.height }).toEqual({ w: tilePixels(a.size).width, h: tilePixels(a.size).height });
      expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.height).toBeLessThanOrEqual(layout.height);
      for (const b of layout.tiles.slice(index + 1)) {
        const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
        expect(apart, `${a.size} and ${b.size}`).toBe(true);
      }
    }
    // A row wraps before it passes the width: 4x2 (626px) does not fit beside the first three.
    expect(layout.tiles.find((tile) => tile.size === "4x2")!.y).toBeGreaterThan(layout.tiles[0]!.y);
  });

  it("judges a tile that is taller than its frame, and names the look in the summary", () => {
    const report = { surface: "board", size: "1x1", width: 150, height: 150, scrollWidth: 150, scrollHeight: 400, contentHeight: 400, hasText: true, hasMedia: false, errors: [], rejections: [], console: [], ccb: [], resources: [] } as FrameReport;
    expect(judge(report, "tile 1x1", false)).toEqual([{ level: "warning", place: "tile 1x1", text: "Taller than its tile: 400px of content in 150px, the rest is cut off (collapse to a summary when short)" }]);
    expect(judge({ ...report, surface: "chat" }, "chat", false)).toEqual([]);
    expect(summary("card", { kind: "example" }, [], [], null, [], "light").split("\n")[0]).toBe("Component card: 0 frames drawn (light theme; data from about.md's example).");
    expect(summary("card", { kind: "example" }, [], [], null).split("\n")[0]).toContain("(dark theme;");
    expect(LOOKS.light.ground).not.toBe(LOOKS.dark.ground);
  });

  it("has a --help that names every flag, the pictures, the command a bot runs and where the documentation is", () => {
    expect(wantsHelp(["electron", ".", FLAG, "--help"])).toBe(true);
    expect(wantsHelp(["electron", ".", FLAG, "comp", "-h"])).toBe(true);
    expect(wantsHelp(["electron", ".", FLAG, "comp"])).toBe(false);
    expect(wantsHelp(["electron", ".", "--help"])).toBe(false);
    for (const word of ["--out", "--data", "--folder", "--surfaces", "--sizes", "--theme dark|light", "tile-<size>.png", "contact-sheet.png", "report.json", "$BOTLING_SHOT_COMMAND", "desktop/README.md"]) expect(HELP, word).toContain(word);
    expect(USAGE).toContain("--help");
    expect(HELP.startsWith(USAGE.split("\nMore:")[0]!)).toBe(true);
  });

  it("gives the pins' web part to a shot without a core: its source, stylesheet urls, and files only inside the plugin", () => {
    const base = tempDir("shots-plugins");
    const plugin = join(base, SHOT_PLUGIN);
    mkdirSync(join(plugin, "dist"), { recursive: true });
    // The real manifest: the shot reads `ccb.web` and `ccb.styles` from it.
    writeFileSync(join(plugin, "package.json"), readFileSync(join(__dirname, "..", "..", "builtin-plugins", SHOT_PLUGIN, "package.json")));
    writeFileSync(join(plugin, "dist", "web.js"), "export function activate(){}");
    writeFileSync(join(plugin, "dist", "board.css"), ".pin{}");
    writeFileSync(join(plugin, "dist", "font.woff2"), "font");
    writeFileSync(join(plugin, "dist", "secret.txt"), "no");
    writeFileSync(join(plugin, "root.woff2"), "font");
    writeFileSync(join(base, "outside.css"), "x{}");
    symlinkSync(join(base, "outside.css"), join(plugin, "dist", "link.woff2"));
    const specs = shotWebSpecs(base);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: SHOT_PLUGIN, source: "export function activate(){}", builtIn: true, settings: {}, commands: [], styles: [`botling-chat://chat/plugin-files/${SHOT_PLUGIN}/dist/board.css`] });
    expect(shotPluginFile(base, SHOT_PLUGIN, "dist/board.css")).toMatchObject({ type: "text/css; charset=utf-8" });
    expect(shotPluginFile(base, SHOT_PLUGIN, "dist/font.woff2")).toMatchObject({ type: "font/woff2" });
    for (const refused of ["dist/secret.txt", "dist/web.js", "../outside.css", "/etc/hosts", "dist/.hidden.woff2", "dist/link.woff2", "dist/missing.woff2", "root.woff2"]) expect(shotPluginFile(base, SHOT_PLUGIN, refused), refused).toBeNull();
    expect(shotPluginFile(base, "botling.note", "dist/board.css")).toBeNull();
    // A build without the plugin: nothing (the shot then draws no pins and says so, never hangs).
    expect(shotWebSpecs(join(base, "none"))).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses what the first test's manifest cannot reach: a hidden file or an absolute path where a stylesheet sits at the folder's top, a web part that is a link out, a folder or outside the plugin", () => {
    const base = tempDir("shots-plugins-top");
    const plugin = join(base, SHOT_PLUGIN);
    mkdirSync(join(plugin, "sub"), { recursive: true });
    const manifest = (web: string) => writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: SHOT_PLUGIN, version: "1.2.3", ccb: { web, styles: ["board.css"] } }));
    manifest("web.js");
    writeFileSync(join(plugin, "web.js"), "export const a = 1;");
    writeFileSync(join(plugin, "board.css"), ".pin{}");
    writeFileSync(join(plugin, "ok.woff2"), "font");
    writeFileSync(join(plugin, "extra.css"), ".more{}");
    writeFileSync(join(plugin, "sub", "ok.woff2"), "font");
    writeFileSync(join(plugin, ".hidden.woff2"), "font");
    writeFileSync(join(plugin, "sub", ".hidden.woff2"), "font");
    writeFileSync(join(base, "outside.woff2"), "font");
    writeFileSync(join(base, "outside.js"), "export const secret = 1;");
    // A stylesheet at the top of the folder: any font or picture in the folder is "beside" it, except hidden ones and anything outside.
    for (const served of ["board.css", "ok.woff2", "sub/ok.woff2", "./sub/../ok.woff2"]) expect(shotPluginFile(base, SHOT_PLUGIN, served), served).not.toBeNull();
    for (const refused of [".hidden.woff2", "sub/.hidden.woff2", "/ok.woff2", "../outside.woff2", "sub/../../outside.woff2", "sub", "board.css/../.hidden.woff2", "extra.css"]) expect(shotPluginFile(base, SHOT_PLUGIN, refused), refused).toBeNull();
    expect(shotWebSpecs(base)).toHaveLength(1);
    // The web part must be a regular file inside the plugin: outside by "..", a link out, a folder, a missing file.
    manifest("../outside.js");
    expect(shotWebSpecs(base)).toEqual([]);
    manifest("web-link.js");
    symlinkSync(join(base, "outside.js"), join(plugin, "web-link.js"));
    expect(shotWebSpecs(base)).toEqual([]);
    manifest("sub");
    expect(shotWebSpecs(base)).toEqual([]);
    manifest("missing.js");
    expect(shotWebSpecs(base)).toEqual([]);
    writeFileSync(join(plugin, "package.json"), "{ not json");
    expect(shotWebSpecs(base)).toEqual([]);
    expect(shotPluginFile(base, SHOT_PLUGIN, "board.css")).toBeNull();
    rmSync(base, { recursive: true, force: true });
  });

  it("the shot's host page asks for the web parts and hands the chat page the pins' one (the reason pinned and floating drew nothing)", () => {
    const page = SHOT_JS(1);
    expect(page).toContain('type: "plugins.web"');
    expect(page).toContain(`spec.name === "${SHOT_PLUGIN}"`);
    expect(page).toContain("__shotTiles");
  });

  it("tells a plugin-started worker with Bash the shot command in one line, and nobody else", async () => {
    const command = "env -u ELECTRON_RUN_AS_NODE '/Apps/Botling.app/Contents/MacOS/Botling' --component-shot";
    const rule = shotWorkerRule(command);
    expect(rule).toContain(command);
    expect(rule).toContain("never hunt for or launch your own Chrome");
    expect(rule.split("\n")).toHaveLength(1);
    expect(claudeWorkerPolicy()).not.toContain("Screenshots:");
    expect(claudeWorkerPolicy(undefined, command).split("\n").at(-1)).toBe(rule);
    const h = claudeHarness();
    (h.workers as unknown as { adapter: { options: { shotCommand?: () => string | null } } }).adapter.options.shotCommand = () => command;
    await h.workers.startFor({ instructions: "designer" });
    await h.workers.tool("app_handoff", { instructions: "the bot's own" });
    expect(h.heads[0]!.config.systemPrompt).toContain(rule);
    expect(h.heads[1]!.config.systemPrompt).not.toContain("Screenshots:");
    (h.workers as unknown as { adapter: { options: { shotCommand?: () => string | null } } }).adapter.options.shotCommand = () => null;
    await h.workers.startFor({ instructions: "no command" });
    expect(h.heads[2]!.config.systemPrompt).not.toContain("Screenshots:");
    await h.workers.close();
  });

  it("a plugin-started worker whose agent definition leaves Bash out gets no shot line (it could not run it); one that lists Bash gets it", async () => {
    const command = "env -u ELECTRON_RUN_AS_NODE '/Apps/Botling.app/Contents/MacOS/Botling' --component-shot";
    const h = claudeHarness();
    (h.workers as unknown as { adapter: { options: { shotCommand?: () => string | null } } }).adapter.options.shotCommand = () => command;
    mkdirSync(join(h.cwd, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h.cwd, ".claude", "agents", "reader.md"), "---\nname: reader\ndescription: Reads\ntools: Read, Grep\n---\nYou read.\n");
    writeFileSync(join(h.cwd, ".claude", "agents", "runner.md"), "---\nname: runner\ndescription: Runs\ntools: Read, Bash\n---\nYou run.\n");
    await h.workers.startFor({ instructions: "read", subagent_type: "reader" });
    await h.workers.startFor({ instructions: "run", subagent_type: "runner" });
    await h.workers.tool("app_handoff", { instructions: "the bot's own runner", subagent_type: "runner" });
    expect(h.heads[0]!.config.systemPrompt).not.toContain("Screenshots:");
    expect(h.heads[1]!.config.systemPrompt).toContain(shotWorkerRule(command));
    expect(h.heads[2]!.config.systemPrompt).not.toContain("Screenshots:");
    await h.workers.close();
  });
});
