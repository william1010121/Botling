// Plugins' skills for every engine (plugins/engine-skills.ts): Claude gets a small plugin folder per skill folder (--plugin-dir),
// Antigravity a skills.json in its app-owned profile, Codex the folders over the app-server (codex.test.ts); every one is pointed
// at the plugin's own files through the stable <data>/plugin-guides/<plugin> link, never at a copy.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { claudePluginName, claudeSkillFolders, placedSkillRoot } from "../../src/core/plugins/engine-skills";
import { writeAgySkills } from "../../src/core/agent/agy-acp";

const DOCS = "skills/report/report-blocks.md";
const report = (root: string, text: string) => {
  const folder = join(root, "botling.report");
  mkdirSync(join(folder, "skills", "report"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "botling.report", version: "1.0.0", ccb: { contributes: { skills: "skills", agentCommands: [{ id: "botling.report.render", script: "report.cjs", flag: "--render-report", docs: DOCS }] } } }));
  writeFileSync(join(folder, "report.cjs"), "");
  writeFileSync(join(folder, "skills", "report", "SKILL.md"), `---\nname: report\ndescription: ${text}\n---\n`);
  writeFileSync(join(folder, DOCS), text);
  return folder;
};

describe("placedSkillRoot", () => {
  it("names the skill folder through the guide link, which follows an override and comes back", () => {
    const shipped = report(tempDir("skills-shipped"), "shipped"), overrides = tempDir("skills-overrides"), guides = join(tempDir("skills-data"), "plugin-guides");
    const command = { plugin: "botling.report", folder: shipped, flag: "--render-report" };
    const placed = placedSkillRoot(join(shipped, "skills"), command, guides, overrides);
    expect(placed).toBe(join(guides, "botling.report", "skills"));
    expect(readFileSync(join(placed, "report", "SKILL.md"), "utf8")).toContain("shipped");
    // A rebuilt override: the same path, its files.
    report(overrides, "rebuilt");
    expect(placedSkillRoot(join(shipped, "skills"), command, guides, overrides)).toBe(placed);
    expect(readFileSync(join(placed, "report", "SKILL.md"), "utf8")).toContain("rebuilt");
    expect(readFileSync(join(guides, "botling.report", DOCS), "utf8")).toBe("rebuilt");
  });

  it("leaves a folder as it is without a command, or outside the command's plugin", () => {
    const guides = join(tempDir("skills-data-2"), "plugin-guides");
    expect(placedSkillRoot("/lib/other/skills", undefined, guides)).toBe("/lib/other/skills");
    expect(placedSkillRoot("/lib/other/skills", { plugin: "botling.report", folder: "/lib/botling.report", flag: "--render-report" }, guides)).toBe("/lib/other/skills");
    expect(existsSync(guides)).toBe(false);
  });
});

describe("claudeSkillFolders", () => {
  it("makes a Claude plugin folder whose skills link to the plugin's own, and keeps it as it is next time", () => {
    const shipped = report(tempDir("skills-claude"), "shipped"), base = join(tempDir("skills-claude-data"), "plugin-skills", "claude");
    const [folder, ...rest] = claudeSkillFolders([{ plugin: "botling.report", root: join(shipped, "skills") }], base);
    expect(rest).toEqual([]);
    expect(folder).toBe(join(base, "botling.report"));
    expect(JSON.parse(readFileSync(join(folder!, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "botling-report" });
    expect(readlinkSync(join(folder!, "skills"))).toBe(join(shipped, "skills"));
    expect(readFileSync(join(folder!, "skills", "report", "SKILL.md"), "utf8")).toContain("shipped");
    const written = statSync(join(folder!, ".claude-plugin", "plugin.json")).mtimeMs;
    expect(claudeSkillFolders([{ plugin: "botling.report", root: join(shipped, "skills") }], base)).toEqual([folder]);
    expect(statSync(join(folder!, ".claude-plugin", "plugin.json")).mtimeMs).toBe(written);
    // Another root: the link is pointed there.
    const other = report(tempDir("skills-claude-2"), "other");
    claudeSkillFolders([{ plugin: "botling.report", root: join(other, "skills") }], base);
    expect(readlinkSync(join(folder!, "skills"))).toBe(join(other, "skills"));
  });

  it("gives each further folder of one plugin a folder of its own, and leaves out one it cannot make", () => {
    const base = join(tempDir("skills-claude-3"), "claude");
    expect(claudeSkillFolders([{ plugin: "a.b", root: "/x/one" }, { plugin: "a.b", root: "/x/two" }], base)).toEqual([join(base, "a.b"), join(base, "a.b.2")]);
    expect(JSON.parse(readFileSync(join(base, "a.b.2", ".claude-plugin", "plugin.json"), "utf8")).name).toBe("a-b-2");
    // Something that is not a link where `skills` goes: left out.
    mkdirSync(join(base, "c", "skills"), { recursive: true });
    expect(claudeSkillFolders([{ plugin: "c", root: "/x/three" }], base)).toEqual([]);
    expect(claudePluginName("Botling.Report")).toBe("botling-report");
  });
});

describe("writeAgySkills", () => {
  it("writes the profile's skills.json with one entry per folder, and removes it when there are none", () => {
    const home = tempDir("agy-skills-home");
    mkdirSync(join(home, "config"), { recursive: true });
    writeAgySkills(home, ["/data/plugin-guides/botling.report/skills"]);
    const file = join(home, "config", "skills.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ entries: [{ path: "/data/plugin-guides/botling.report/skills" }] });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no POSIX modes
    writeAgySkills(home, []);
    expect(existsSync(file)).toBe(false);
  });
});
