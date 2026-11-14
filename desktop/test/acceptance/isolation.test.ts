// Acceptance check 1 (M1 brief §5), the isolation part: the 2.x app built from main uses no 3.x code path and never
// opens a 3.x data folder; botlingd never opens a 2.x one.
//
// - Bundles: every source map under out/ (built by `npm run build`, the same build.mjs as the release) lists the files
//   its bundle was made from. The 2.x bundles (main, core, preloads, renderer, chat page, CLI, plugin host checker,
//   phone pairing) must list nothing from src/server, src/fe-link, src/main-v3 or src/protocol. The 3.x bundles are
//   listed with the 2.x modules they share, for the record.
// - botlingd on a folder shaped like 2.x data (synthetic: projects/, main/, settings.json; never a real data folder) is
//   refused (exit 2) and writes nothing into it.
// - Botling 3's window main refuses 2.x's developer data folder (main-v3/paths.ts).
// - The 2.x core (out/core/main.cjs, its own stdio transport, plain Node) on a folder botlingd holds exits 75 (data
//   folder lock); on a stopped botlingd folder its behaviour is recorded (not asserted: the 2.x app never points there).
//
//   V3_ACCEPT_REPORT_DIR
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { v3DataDir } from "../../src/main-v3/paths";
import { botlingdScript } from "../botlingd-harness";
import { desktop, fakeCli } from "../helpers";
import { Daemon, removeTree, runtimeCommand, runtimeOf, testRoot, writeReport } from "./m1-accept";

const V3 = /(^|\/)src\/(server|fe-link|main-v3|protocol)\//;
const out = join(desktop, "out");

function maps(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) { if (name.name !== "node_modules") found.push(...maps(path)); }
    else if (name.name.endsWith(".map")) found.push(path);
  }
  return found;
}

function tree(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    out.push(relative(dir, path));
    if (name.isDirectory()) out.push(...tree(path).map((p) => join(name.name, p)));
  }
  return out.sort();
}

function core2x(dataDir: string, ms: number): Promise<{ code: number | null; stderr: string; ranMs: number }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("BOTLING_") && !k.startsWith("ELECTRON_")) env[k] = v;
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(out, "core", "main.cjs")], { env: { ...env, BOTLING_DATA_DIR: dataDir, BOTLING_AGENT: "fake", BOTLING_FAKE_CLI: fakeCli, BOTLING_CLAIM_WAIT_MS: "500" }, stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4_000); });
    const timer = setTimeout(() => child.kill("SIGTERM"), ms);
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stderr, ranMs: Date.now() - t0 }); });
  });
}

describe("acceptance check 1: 2.x and 3.x stay apart", () => {
  it("2.x bundles carry no 3.x code; botlingd refuses 2.x data; 2.x core refuses a held 3.x folder", async () => {
    const report: Record<string, unknown> = { runtime: runtimeOf() };
    const bundles: Record<string, { sources: number; v3: string[]; kind: string }> = {};
    for (const map of maps(out)) {
      const sources = (JSON.parse(readFileSync(map, "utf8")) as { sources?: string[] }).sources ?? [];
      const name = relative(out, map);
      const kind = name.startsWith("server/") || name.startsWith("main-v3/") ? "3.x" : "2.x";
      bundles[name] = { sources: sources.length, v3: sources.filter((s) => V3.test(s)).map((s) => s.replace(/^(\.\.\/)+/, "")), kind };
    }
    report.bundles = Object.fromEntries(Object.entries(bundles).map(([k, v]) => [k, { kind: v.kind, sources: v.sources, v3Sources: v.kind === "2.x" ? v.v3 : v.v3.length }]));
    const leaks = Object.entries(bundles).filter(([, v]) => v.kind === "2.x" && v.v3.length);
    report.leaks = leaks.map(([k, v]) => ({ bundle: k, files: v.v3 }));
    for (const bundle of ["main/main.cjs.map", "core/main.cjs.map", "preload/preload.cjs.map", "renderer/renderer.js.map", "renderer/chat.js.map"]) expect(bundles[bundle], bundle).toBeDefined();
    expect(bundles["server/main.cjs.map"]?.v3.length).toBeGreaterThan(0);
    // What the 3.x bundles share with 2.x (src/core, src/contract, src/main …), for the record.
    for (const name of ["server/main.cjs.map", "main-v3/main.cjs.map"]) {
      const sources = (JSON.parse(readFileSync(join(out, name), "utf8")) as { sources: string[] }).sources.map((s) => s.replace(/^(\.\.\/)+/, ""));
      const groups: Record<string, number> = {};
      for (const s of sources) { const m = /^(?:desktop\/)?(src\/[^/]+|Web\/[^/]+|node_modules)/.exec(s); const key = m ? m[1] : "other"; groups[key] = (groups[key] ?? 0) + 1; }
      (report.shared ??= {} as Record<string, unknown>) && ((report.shared as Record<string, unknown>)[name] = groups);
    }

    const root = testRoot("v3-accept-isolation");
    try {
      // botlingd on a 2.x-shaped folder.
      const fake2x = join(root, "looks-2x");
      mkdirSync(join(fake2x, "projects"), { recursive: true });
      mkdirSync(join(fake2x, "main"), { recursive: true });
      writeFileSync(join(fake2x, "settings.json"), "{}");
      const before = tree(fake2x);
      const { bin, env } = runtimeCommand(runtimeOf());
      const run = spawnSync(bin, ["--no-warnings", botlingdScript, "start"], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BOTLING_SERVER_DATA_DIR: fake2x, ...env }, encoding: "utf8", timeout: 60_000 });
      const after = tree(fake2x);
      report.botlingdOn2xFolder = { exit: run.status, stderr: run.stderr.trim().replace(root, "<tmp>"), filesBefore: before, filesAfter: after, untouched: JSON.stringify(before) === JSON.stringify(after) };
      expect(run.status).toBe(2);
      expect(run.stderr).toMatch(/2\.x data folder/);
      expect(after).toEqual(before);

      // The window main's guard.
      const devData = v3DataDir(desktop, { BOTLING_DATA_DIR: join(desktop, ".data") });
      const defaultData = v3DataDir(desktop, {});
      report.mainV3Guard = { on2xDevFolder: devData.ok ? "accepted" : `refused: ${devData.error}`, default: defaultData.ok ? relative(desktop, defaultData.dataDir) : defaultData.error };
      expect(devData.ok).toBe(false);

      // The 2.x core on botlingd's folder: refused while botlingd holds it.
      const v3 = join(root, "v3");
      const daemon = new Daemon(v3);
      await daemon.ready();
      const held = await core2x(v3, 15_000);
      report.core2xOnHeldV3Folder = { exit: held.code, ranMs: held.ranMs, stderr: held.stderr.trim().split("\n").slice(-2).join(" ").replace(root, "<tmp>") };
      expect(held.code).toBe(75);
      expect((await daemon.stop()).code).toBe(0);
      // …and on the same folder with botlingd stopped (recorded only).
      const beforeStopped = tree(v3);
      const stopped = await core2x(v3, 4_000);
      const afterStopped = tree(v3);
      report.core2xOnStoppedV3Folder = {
        exit: stopped.code, ranMs: stopped.ranMs, refused: stopped.ranMs < 3_500 && stopped.code !== null && stopped.code !== 0,
        added: afterStopped.filter((p) => !beforeStopped.includes(p)), stderrTail: stopped.stderr.trim().split("\n").slice(-2).join(" ").replace(root, "<tmp>"),
      };
    } finally {
      console.log(`report: ${writeReport("isolation", report)}`);
      removeTree(root);
    }
    expect(report.leaks).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });
});
