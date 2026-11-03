// `Botling 2 --render-report`: main finds the script in the plugins shipped with the app (plugins/app-command.ts), by the flag a plugin
// declares in `contributes.agentCommands`, never in the user's plugin library.
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";
import { appCommandScript } from "../../src/core/plugins/app-command";

const plugin = (root: string, name: string, commands: unknown) => {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "package.json"), JSON.stringify({ name, version: "1.0.0", ccb: { contributes: { agentCommands: commands } } }));
};

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
});
