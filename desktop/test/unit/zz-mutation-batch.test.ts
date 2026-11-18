// REVIEW-ONLY driver (L-010): one connection, each mutant patched, the three override test files run, the file restored. Removed after the run.
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const desktop = join(__dirname, "..", "..");
const FILES = ["test/unit/builtin-overrides.test.ts", "test/unit/builtin-overrides-host.test.ts", "test/unit/builtin-overrides-wiring.test.ts"];
const O = "src/core/plugins/overrides.ts", R = "src/core/plugins/registry.ts", I = "src/core/plugins/index.ts", W = "src/core/server/plugin-world.ts", S = "scripts/push-builtin-plugin.mjs";
type M = { id: string; file: string; from: string; to: string };
const M: M[] = [
  { id: "O1 gate removed", file: O, from: 'if (!on) return this.refuse(name, stamp.dir, "developer mode is off (Settings → Developer mode)");', to: "" },
  { id: "O2 gate throw = on", file: O, from: "catch { on = false; }", to: "catch { on = true; }" },
  { id: "O3 stale drop removed", file: O, from: "if (stamp.pushedAt + TOLERANCE_MS < shippedLaidDownAt(shipped.folder)) {", to: "if (false) {" },
  { id: "O4 tolerance 0", file: O, from: "const TOLERANCE_MS = 1000;", to: "const TOLERANCE_MS = 0;" },
  { id: "O5 tolerance huge", file: O, from: "const TOLERANCE_MS = 1000;", to: "const TOLERANCE_MS = 100000;" },
  { id: "O6 core-fixed check removed", file: O, from: "if (!NAME.test(name) || CORE_FIXED_PLUGINS.includes(name)) return null;", to: "if (!NAME.test(name)) return null;" },
  { id: "O7 mode check removed", file: O, from: "return (stat.mode & 0o022) === 0;", to: "return true;" },
  { id: "O8 uid check removed (untestable w/o chown)", file: O, from: "stat.uid !== process.getuid()", to: "false" },
  { id: "O9 stamp dir rule removed", file: O, from: "if (dir !== `${name}@${hash.slice(0, 12)}`) return null;", to: "" },
  { id: "O10 hash check removed", file: O, from: "try { ok = folderHash(folder) === stamp.folderHash; } catch { ok = false; }", to: "ok = true;" },
  { id: "O11 look cache ignores signature", file: O, from: "known.signature === signature", to: "true" },
  { id: "O12 manifest name rule removed", file: O, from: "if (loaded.manifest.name !== name) return this.refuse", to: "if (false) return this.refuse" },
  { id: "O13 older-version rule removed", file: O, from: "if (order !== null && order < 0)", to: "if (false)" },
  { id: "O14 say-once removed", file: O, from: "if (this.said.get(name) !== text) {", to: "if (true) {" },
  { id: "O16 stamp isFile removed (equivalent: lstat mode of a link fails ownedAndClosed)", file: O, from: "!stat.isFile() || ", to: "" },
  { id: "O17 stamp size cap removed", file: O, from: "stat.size > MAX_STAMP_BYTES || ", to: "" },
  { id: "O18 stamp v rule removed", file: O, from: "v !== 1 || ", to: "" },
  { id: "O19 stamp plugin rule removed", file: O, from: "plugin !== name || ", to: "" },
  { id: "O20 stamp hash shape removed", file: O, from: "!HASH.test(hash) || ", to: "" },
  { id: "O21 stamp pushedAt shape removed", file: O, from: "typeof pushedAt !== \"number\" || !Number.isFinite(pushedAt)", to: "false" },
  { id: "O22 plainSignature link rule removed (equivalent: hash differs)", file: O, from: "if (!entry.isFile()) return null;", to: "" },
  { id: "O23 shipped version asked before the mode", file: O, from: "    let on = false;", to: "    shippedVersion();\n    let on = false;" },
  { id: "O24 developerMode strict true removed", file: O, from: "this.developerMode() === true", to: "!!this.developerMode()" },
  { id: "R1 library plugins looked at", file: R, from: "if (builtIn && this.pushedCopies) {", to: "if (this.pushedCopies) {" },
  { id: "R3 pushed flag dropped", file: R, from: "...(pushed ? { pushed } : {}),", to: "" },
  { id: "R5 registry default mode on", file: R, from: "developerMode: () => boolean = () => false", to: "developerMode: () => boolean = () => true" },
  { id: "R6 registry ignores mode", file: R, from: "}, developerMode) : null;", to: "}, () => true) : null;" },
  { id: "I1 Plugins default mode on", file: I, from: "options.developerMode ?? (() => false)", to: "options.developerMode ?? (() => true)" },
  { id: "I2 Plugins drops pushed notes", file: I, from: "this.registry.onPushedNote = (text) => world.log(text);", to: "" },
  { id: "W1 core mode always on", file: W, from: "developerMode: () => settingsView(readSettings(Layout.settings(options.dataDir))).developerMode,", to: "developerMode: () => true," },
  { id: "S1 script core-fixed rule removed", file: S, from: "if (CORE_FIXED_PLUGINS.includes(name)) throw", to: "if (false) throw" },
  { id: "S2 script link rule removed", file: S, from: "else if (!entry.isFile()) throw", to: "else if (false) throw" },
  { id: "S3 closeWrite keeps group/world write", file: S, from: "(lstatSync(path).mode & 0o777 & ~0o022) | 0o600", to: "(lstatSync(path).mode & 0o777) | 0o600" },
  { id: "S4 closeWrite dir mode", file: S, from: "chmodSync(dir, 0o755);", to: "" },
  { id: "S5 previous folder dropped", file: S, from: "entry !== dir && entry !== previous", to: "entry !== dir" },
  { id: "S6 placeOverride name check removed", file: S, from: "export function placeOverride({ built, name, root, now = Date.now() }) {\n  if (!NAME.test(name)) throw new Error(`\"${name}\" is not a plugin name.`);", to: "export function placeOverride({ built, name, root, now = Date.now() }) {" },
  { id: "S7 removeOverride name check removed", file: S, from: "export function removeOverride({ name, root }) {\n  if (!NAME.test(name)) throw new Error(`\"${name}\" is not a plugin name.`);", to: "export function removeOverride({ name, root }) {" },
  { id: "S8 agent-command note removed", file: S, from: "if (agentCommandsOf(built) > 0) log(", to: "if (false) log(" },
  { id: "S9 failed check still places", file: S, from: "if (problems.length) throw new Error(", to: "if (false) throw new Error(" },
];

const EXTRA = ["test/unit/plugin-kernel-goldens.test.ts", "test/unit/plugin-kernel-goldens-broker.test.ts", "test/unit/plugin-frame-events.test.ts", "test/unit/core-seq.test.ts"];
const run = (baseline = false): { ok: boolean; tail: string; full: string } => {
  const r = spawnSync("npx", ["vitest", "run", ...FILES, ...(baseline ? EXTRA : []), ...(baseline ? [] : ["-t", "^(?!.*the real botling\\.catchup)"]), "--reporter=dot"], { cwd: desktop, encoding: "utf8", env: { ...process.env, CI: "1" }, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, full: `${r.stdout}${r.stderr}`.split("\n").slice(-150).join("\n"), tail: `${r.stdout}${r.stderr}`.split("\n").filter((l) => /FAIL|✗|×|AssertionError|Error:/.test(l)).slice(0, 4).join(" | ") };
};

describe("mutation batch", () => {
  it("every mutant is killed or named", () => {
    const base = run(true);
    console.log(`MUTATION baseline ${base.ok ? "PASS" : "FAIL\n" + base.full}`);
    expect(base.ok).toBe(true);
    const rows: string[] = [];
    for (const m of M) {
      const path = join(desktop, m.file);
      const original = readFileSync(path, "utf8");
      const count = original.split(m.from).length - 1;
      if (count !== 1) { rows.push(`${m.id}: INVALID (pattern found ${count}x)`); continue; }
      try {
        writeFileSync(path, original.replace(m.from, () => m.to));
        const r = run();
        rows.push(`${m.id}: ${r.ok ? "SURVIVED" : "killed"}${r.ok ? "" : " (" + r.tail.slice(0, 120) + ")"}`);
      } finally {
        writeFileSync(path, original);
      }
    }
    console.log("MUTATION RESULTS\n" + rows.join("\n"));
  }, 3_000_000);
});
