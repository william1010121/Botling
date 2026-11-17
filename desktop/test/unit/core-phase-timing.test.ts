// The core's startup timing (core/phase-marks.ts, `phaseLog`): one `timing:` line per construction and activation phase,
// and the slowest bots in one line each.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Core } from "../../src/core/server";
import { tempDir } from "../helpers";

function builtIn(dir: string) {
  const folder = join(dir, "builtin", "shipped");
  mkdirSync(join(folder, "dist"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "shipped", displayName: "shipped", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { host: "dist/host.mjs", permissions: ["bots"] } }));
  writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() {}");
}

const running: Core[] = [];
afterEach(async () => { for (const core of running.splice(0)) await core.shutdown(); });

function make(phaseLog?: (line: string) => void) {
  const dir = tempDir("core-phase-timing");
  builtIn(dir);
  const core = new Core({
    dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {},
    plugins: { node: null, hostScript: "", sealer: null, builtIns: join(dir, "builtin") },
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0,
    ...(phaseLog ? { phaseLog } : {}),
  });
  running.push(core);
  return core;
}

describe("Core startup timing", () => {
  it("writes the construction and activation phases and one slowest-bots line each", () => {
    const lines: string[] = [];
    make((line) => lines.push(line));
    expect(lines.filter((line) => /^timing: core construct: constructor total \d+ ms$/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^timing: core construct: bots \d+ slowest of \d+: "/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^timing: core activate: bots \d+ slowest of \d+: "/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^timing: core activate: activate total \d+ ms$/.test(line))).toHaveLength(1);
    expect(lines.every((line) => /^timing: core (construct|activate): .* (\d+ ms|slowest of \d+: .*)$/.test(line))).toBe(true);
  });
});
