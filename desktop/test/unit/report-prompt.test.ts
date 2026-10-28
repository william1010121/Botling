// The report page rule (2.0 only): every bot, the main bot and Codex workers are told to build
// report pages as ReportSpec v2 with the app's report command, right after the results rule,
// which stays exactly as it was. Without the command (headless tests) nothing is added.
import { describe, expect, it } from "vitest";
import { botPrompts, desktopPrompts, reportPageLine, type ReportTool } from "../../src/core/prompts";

const tool: ReportTool = { command: "env -u ELECTRON_RUN_AS_NODE '/Applications/Botling 2.app/Contents/MacOS/Botling 2' --render-report", docs: "/Applications/Botling 2.app/Contents/Resources/report/report-blocks.md" };
const profile = (role: "main" | "manager" | "bot") => ({ name: "P", role, folder: "/tmp/p", memoryPath: role === "main" ? "memory.md" : ".bot/memory.md", job: role === "bot" ? "News" : null });

describe("the report page rule", () => {
  for (const role of ["main", "manager", "bot"] as const) {
    for (const engine of ["claude", "codex"] as const) {
      it(`follows the results rule for a ${role} (${engine}) and keeps the rest unchanged`, () => {
        const plain = botPrompts({ profile: profile(role), engine });
        const ours = desktopPrompts(plain, profile(role), tool);
        const artifacts = role === "main" ? "/tmp/p/artifacts" : "/tmp/p/.bot/artifacts";
        const line = reportPageLine(tool, artifacts);
        const lines = ours.system.split("\n");
        const at = lines.indexOf(line);
        expect(at).toBeGreaterThan(0);
        expect(lines[at - 1]).toContain(role === "main" ? "You are the single point of contact." : "Results meant for the user");
        // Nothing else moves: removing the line gives the prompts without it.
        expect(lines.filter((l) => l !== line).join("\n")).toBe(desktopPrompts(plain, profile(role)).system);
        expect(ours.codexWorkerSystem.split("\n")).toContain(line);
        expect(line).toContain(`${tool.command} spec.json '${artifacts}/<english-name>.html' exactly as quoted`);
        expect(line).toContain(`read '${tool.docs}'`);
      });
    }
  }

  it("is short, names the result contract and leaves publishing to the results rule", () => {
    const line = reportPageLine(tool, "/x/artifacts");
    expect(line.length).toBeLessThan(800);
    expect(line).toContain("{ok, errors, warnings, htmlPath, link}");
    expect(line).toContain("as the results rule says");
    expect(line).not.toMatch(/Artifact tool|claude\.ai/);
  });

  it("adds nothing when the app has no report command", () => {
    const plain = botPrompts({ profile: profile("bot") });
    expect(desktopPrompts(plain, profile("bot"), null).system).toBe(desktopPrompts(plain, profile("bot")).system);
  });
});

describe("the report page line as a shell command", () => {
  it("keeps a spaced command path and a spaced artifacts path one argument each under zsh", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "report line ")));
    const app = join(base, "Botling 2.app", "Contents", "MacOS");
    mkdirSync(app, { recursive: true });
    const binary = join(app, "Botling 2");
    writeFileSync(binary, `#!/bin/sh\n${process.execPath.replaceAll(" ", "\\ ")} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`);
    chmodSync(binary, 0o755);
    const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
    const artifacts = join(base, "My Project's", ".bot", "artifacts");
    const line = reportPageLine({ command: `${quoted} --render-report`, docs: join(base, "Botling 2.app", "Contents", "Resources", "report", "report-blocks.md") }, artifacts);
    const command = /; run (.*) exactly as quoted/.exec(line)![1].replace("<english-name>", "a b");
    const argv = JSON.parse(execFileSync("zsh", ["-f", "-c", command], { encoding: "utf8" }));
    expect(argv).toEqual(["--render-report", "spec.json", join(artifacts, "a b.html")]);
    expect(line).toContain(`read '${join(base, "Botling 2.app", "Contents", "Resources", "report", "report-blocks.md")}'`);
  });
});
