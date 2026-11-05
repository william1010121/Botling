// `Botling 2 --render-report`: main finds the script in the plugins shipped with the app (plugins/app-command.ts), by the flag a plugin
// declares in `contributes.agentCommands`, never in the user's plugin library; an override folder (<data dir>/plugin-overrides) may
// only replace that same plugin's script for that same flag.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers";
import { appCommandScript, commandGuidePath } from "../../src/core/plugins/app-command";

const plugin = (root: string, name: string, commands: unknown, folder = name) => {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, "package.json"), JSON.stringify({ name, version: "1.0.0", ccb: { contributes: { agentCommands: commands } } }));
  for (const command of commands as { script: string }[]) if (!command.script.includes("..")) { mkdirSync(dirname(join(root, folder, command.script)), { recursive: true }); writeFileSync(join(root, folder, command.script), ""); }
};
const RENDER = [{ id: "botling.report.render", script: "report.cjs", flag: "--render-report" }];

describe("appCommandScript", () => {
  it("finds the script of the plugin that declares the flag", () => {
    const root = tempDir("app-command");
    plugin(root, "botling.other", [{ id: "botling.other.x", script: "x.cjs", flag: "--other" }]);
    plugin(root, "botling.report", [{ id: "botling.report.render", script: "report.cjs", flag: "--render-report" }]);
    expect(appCommandScript(root, "--render-report")).toBe(join(root, "botling.report", "report.cjs"));
    expect(appCommandScript(root, "--nothing")).toBeNull();
  });

  it("answers nothing for a missing folder, a script outside the plugin or a folder that is no plugin", () => {
    const root = tempDir("app-command-none");
    expect(appCommandScript(join(root, "missing"), "--render-report")).toBeNull();
    plugin(root, "botling.bad", [{ id: "botling.bad.x", script: "../escape.cjs", flag: "--render-report" }]);
    mkdirSync(join(root, "not-a-plugin"));
    expect(appCommandScript(root, "--render-report")).toBeNull();
  });

  it("takes the override folder's script for the same plugin and flag, falling back to the shipped one", () => {
    const shipped = tempDir("app-command-shipped"), overrides = tempDir("app-command-overrides");
    plugin(shipped, "botling.report", RENDER);
    expect(appCommandScript(shipped, "--render-report", join(overrides, "missing"))).toBe(join(shipped, "botling.report", "report.cjs"));
    // Matched by manifest name, whatever the folder is called.
    plugin(overrides, "botling.report", [{ ...RENDER[0], script: "dist/report.cjs" }], "my-report");
    expect(appCommandScript(shipped, "--render-report", overrides)).toBe(join(overrides, "my-report", "dist", "report.cjs"));
    expect(appCommandScript(shipped, "--render-report")).toBe(join(shipped, "botling.report", "report.cjs"));
  });

  it("never lets an override add a flag, take another plugin's flag or name a script that is not there", () => {
    const shipped = tempDir("app-command-shipped-2"), overrides = tempDir("app-command-overrides-2");
    plugin(shipped, "botling.report", RENDER);
    plugin(overrides, "evil.report", RENDER);
    plugin(overrides, "botling.report", [{ id: "botling.report.new", script: "new.cjs", flag: "--new-flag" }], "botling.report-new");
    expect(appCommandScript(shipped, "--render-report", overrides)).toBe(join(shipped, "botling.report", "report.cjs"));
    expect(appCommandScript(shipped, "--new-flag", overrides)).toBeNull();
    const gone = tempDir("app-command-overrides-3");
    mkdirSync(join(gone, "botling.report"));
    writeFileSync(join(gone, "botling.report", "package.json"), JSON.stringify({ name: "botling.report", ccb: { contributes: { agentCommands: RENDER } } }));
    expect(appCommandScript(shipped, "--render-report", gone)).toBe(join(shipped, "botling.report", "report.cjs"));
    plugin(gone, "botling.report", [{ ...RENDER[0], script: "../escape.cjs" }], "escape");
    expect(appCommandScript(shipped, "--render-report", gone)).toBe(join(shipped, "botling.report", "report.cjs"));
  });
});

describe("commandGuidePath", () => {
  const DOCS = "skills/report/report-blocks.md";
  const withGuide = (root: string, text: string, folder = "botling.report") => {
    plugin(root, "botling.report", [{ ...RENDER[0], docs: DOCS }], folder);
    mkdirSync(dirname(join(root, folder, DOCS)), { recursive: true });
    writeFileSync(join(root, folder, DOCS), text);
  };

  it("names one stable path whose guide is the override's when there is one, else the shipped one", () => {
    const shipped = tempDir("guide-shipped"), overrides = tempDir("guide-overrides"), guides = join(tempDir("guide-data"), "plugin-guides");
    withGuide(shipped, "shipped rules");
    const command = { plugin: "botling.report", folder: join(shipped, "botling.report"), flag: "--render-report", docs: join(shipped, "botling.report", DOCS) };
    const path = commandGuidePath(command, guides, join(overrides, "missing"));
    expect(path).toBe(join(guides, "botling.report", DOCS));
    expect(readFileSync(path, "utf8")).toBe("shipped rules");
    // A rebuilt plugin in the override folder (any folder name): the same path now reads its guide.
    withGuide(overrides, "override rules", "my-report");
    expect(commandGuidePath(command, guides, overrides)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("override rules");
    expect(readlinkSync(join(guides, "botling.report"))).toBe(join(overrides, "my-report"));
    // Rebuilt again in place: read as it is now, with no call in between.
    writeFileSync(join(overrides, "my-report", DOCS), "newer rules");
    expect(readFileSync(path, "utf8")).toBe("newer rules");
    // The override removed: back to the shipped guide, still the same path.
    rmSync(join(overrides, "my-report"), { recursive: true });
    expect(commandGuidePath(command, guides, overrides)).toBe(path);
    expect(readFileSync(path, "utf8")).toBe("shipped rules");
    // No override folder at all (a headless core): shipped.
    expect(commandGuidePath(command, guides, null)).toBe(path);
  });

  it("keeps the shipped guide for an override without the guide, without its script, or for another flag", () => {
    const shipped = tempDir("guide-shipped-2"), overrides = tempDir("guide-overrides-2"), guides = join(tempDir("guide-data-2"), "plugin-guides");
    withGuide(shipped, "shipped rules");
    const command = { plugin: "botling.report", folder: join(shipped, "botling.report"), flag: "--render-report", docs: join(shipped, "botling.report", DOCS) };
    plugin(overrides, "botling.report", [{ ...RENDER[0], docs: DOCS }]);
    expect(readFileSync(commandGuidePath(command, guides, overrides), "utf8")).toBe("shipped rules");
    plugin(overrides, "botling.report", [{ id: "botling.report.other", script: "other.cjs", flag: "--other", docs: DOCS }]);
    mkdirSync(dirname(join(overrides, "botling.report", DOCS)), { recursive: true });
    writeFileSync(join(overrides, "botling.report", DOCS), "override rules");
    expect(readFileSync(commandGuidePath(command, guides, overrides), "utf8")).toBe("shipped rules");
  });

  it("falls back to the target itself when something that is not a link is in the way", () => {
    const shipped = tempDir("guide-shipped-3"), data = tempDir("guide-data-3");
    withGuide(shipped, "shipped rules");
    mkdirSync(join(data, "plugin-guides", "botling.report"), { recursive: true });
    const command = { plugin: "botling.report", folder: join(shipped, "botling.report"), flag: "--render-report", docs: join(shipped, "botling.report", DOCS) };
    expect(commandGuidePath(command, join(data, "plugin-guides"), null)).toBe(command.docs);
  });
});
