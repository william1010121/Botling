// Component shots (1.x's ComponentShot.swift): the usage, the command line, where the data comes from,
// the Command check, `judge`, `isUniform` and `summary`, equal character for character to what the
// Swift code wrote (test/fixtures/phase5-golden.json `more.shots`, made by
// Tests/ClaudeCodeBotCoreTests/DesktopPhase5GoldenExport.swift).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALL_SIZES, FLAG, PROBE_SCRIPT, USAGE, checkCommand, commandFolder, fileName, isRequested, isUniform, judge, notDrawn, parse, resolveData, sampleData,
  shotSizes, sourceText, summary, withProbe, type DataSource, type FrameReport,
} from "../../src/core/component-shot";
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
});
