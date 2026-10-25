// Component shots (Phase 5a; 1.x's `botling --component-shot`): this build draws a component in its real
// chat page — a reply, Board tiles, opened above the input box, floating — pictures each frame, judges it
// and exits 0 without problems, 1 with them; Maintainer is given the command. Its contact sheet goes to
// desktop/.tmp/screens/.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";
import { launch } from "./launch";

const electron = require("electron") as unknown as string;
function shot(args: string[]) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(electron, [desktop, "--component-shot", ...args], { encoding: "utf8", env, timeout: 120_000 });
}
function component(folder: string, template: string, about: string) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "template.html"), template);
  writeFileSync(join(folder, "about.md"), about);
}

test("draws a good component on every surface: no problems, a picture each, a contact sheet", async () => {
  const base = tempDir("e2e-shot");
  const folder = join(base, "lib", "tests");
  component(folder, `<div class="card" style="padding:12px;font:14px system-ui;color:#e8e8e8"><b>Tests</b> <span id="v"></span></div><script>document.getElementById("v").textContent = ccb.data.passed + " passed";</script>`,
    'Tests: how many passed.\nData: {"passed": 3}\n');
  const out = join(base, "out");
  const run = shot([folder, "--out", out]);
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("Component tests: 7 frames drawn (dark theme; data from about.md's example).\nNo problems.");
  for (const name of ["chat", "board-1x1", "board-2x1", "board-2x2", "board-4x2", "pinned", "floating", "contact-sheet"]) expect(existsSync(join(out, `${name}.png`)), name).toBe(true);
  const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
  expect(report).toMatchObject({ component: "tests", data: "about.md's example", findings: [] });
  mkdirSync(join(desktop, ".tmp", "screens"), { recursive: true });
  copyFileSync(join(out, "contact-sheet.png"), join(desktop, ".tmp", "screens", "phase5a-shot-sheet.png"));
});

test("lists what is wrong and exits 1; a bad folder is a usage error (2); Maintainer gets the command", async () => {
  const base = tempDir("e2e-shot");
  const folder = join(base, "lib", "broken");
  component(folder, `<div class="card"><div style="width:2000px">wide</div></div><script>ccb.nope();</script>`, 'Broken.\nData: {"a": 1}\n');
  const run = shot([folder, "--out", join(base, "out"), "--sizes", "2x2"]);
  expect(run.status).toBe(1);
  expect(run.stdout).toContain("✗ chat, board 2x2, pinned, floating: ccb.nope is not part of ccb (see PLUGINS.md for the API)");
  expect(run.stdout).toMatch(/✗ chat: Wider than its frame: 2000px of content in \d+px, cut off on the right \(widest: div, reaching 2000px\)/);
  expect(shot([join(base, "nowhere")]).status).toBe(2);
  // The app hands Maintainer this build's command.
  const { app, page } = await launch({ dataDir: tempDir("e2e-shot-app") });
  try {
    await page.waitForTimeout(300);
    const command = await app.evaluate(() => (globalThis as unknown as { __botlingShotCommand?: string }).__botlingShotCommand ?? null);
    expect(command).toContain("--component-shot");
    // And the plugin check (Phase 5b): the app's own `--check-plugin`, which a packaged build can run (no Electron as Node).
    const check = await app.evaluate(() => (globalThis as unknown as { __botlingCheckCommand?: string }).__botlingCheckCommand ?? null);
    expect(check).toMatch(/^env -u ELECTRON_RUN_AS_NODE '.+' '.+' --check-plugin$/);
  } finally {
    await app.close();
  }
});

test("--check-plugin checks a plugin folder and exits without a window or a data folder (1.x's flag)", () => {
  const base = tempDir("e2e-check");
  const plugin = join(base, "ccb-good");
  mkdirSync(join(plugin, "dist"), { recursive: true });
  writeFileSync(join(plugin, "dist", "web.js"), "export function activate() {}\n");
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "ccb-good", version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { permissions: [], web: "dist/web.js" } }));
  const env: NodeJS.ProcessEnv = { ...process.env, BOTLING_DATA_DIR: join(base, "data") };
  delete env.ELECTRON_RUN_AS_NODE;
  const good = spawnSync(electron, [desktop, "--check-plugin", plugin], { encoding: "utf8", env, timeout: 60_000 });
  expect(good.status, good.stderr).toBe(0);
  expect(good.stdout).toBe(`✓ ${plugin} passes the checks.\n`);
  writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "Bad Name", version: "x", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/missing.js" } }));
  const bad = spawnSync(electron, [desktop, "--check-plugin", plugin], { encoding: "utf8", env, timeout: 60_000 });
  expect(bad.status).toBe(1);
  expect(bad.stdout).toContain('✗ name "Bad Name" may only use lowercase letters, digits, - . _.');
  expect(bad.stdout).toContain('✗ web points to "dist/missing.js", which does not exist.');
  const usage = spawnSync(electron, [desktop, "--check-plugin"], { encoding: "utf8", env, timeout: 60_000 });
  expect(usage.status).toBe(2);
  expect(usage.stderr).toContain("usage: check-plugin <plugin folder>");
  expect(existsSync(join(base, "data"))).toBe(false);
});
