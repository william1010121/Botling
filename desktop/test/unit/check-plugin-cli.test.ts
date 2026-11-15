// The built `check-plugin` command (out/host/check-plugin.cjs, from src/core/plugins/check-cli.ts) passes the app's
// built-ins folder to the check, so a library copy of a shipped built-in (`botling.*`) is not refused as reserved
// (plugin-dotted-names review M3: no test ran check-cli.ts itself, so passing `null` there went unseen).
//
// The bundle is copied to `<temp>/host/` so its default built-ins folder (`<its folder>/../builtin-plugins`) is a temp
// folder with a made-up "shipped" plugin; BOTLING_BUILTIN_PLUGINS is removed from the child's environment so the
// default is what is used. Needs `npm run build` first (the test commands in AGENTS.md build before they run).
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers";

const BUILT = join(__dirname, "..", "..", "out", "host", "check-plugin.cjs");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A plugin folder `<root>/<folder>` whose manifest says `name`. */
function plugin(root: string, name: string, folder = name): string {
  const dir = join(root, folder);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
  writeFileSync(join(dir, "dist", "web.js"), "export function activate() {}");
  return dir;
}

function setup() {
  if (!existsSync(BUILT)) throw new Error("out/host/check-plugin.cjs is missing: run `npm run build` in desktop/ first");
  const root = tempDir("check-cli");
  roots.push(root);
  mkdirSync(join(root, "host"), { recursive: true });
  copyFileSync(BUILT, join(root, "host", "check-plugin.cjs"));
  const builtIns = join(root, "builtin-plugins");
  plugin(builtIns, "botling.shipped");
  const run = (folder: string) => {
    const env = { ...process.env };
    delete env.BOTLING_BUILTIN_PLUGINS;
    const child = spawnSync(process.execPath, [join(root, "host", "check-plugin.cjs"), folder], { env, encoding: "utf8", timeout: 20_000 });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr };
  };
  return { root, run };
}

describe("the built check-plugin command passes the built-ins folder", () => {
  it("a library copy of a shipped built-in passes; any other botling.* name, and a plain dot, still fail", () => {
    const { root, run } = setup();
    const library = join(root, "library");
    // The shipped name, copied to be changed: checked as a library override of it, so exit 0.
    expect(run(plugin(library, "botling.shipped"))).toMatchObject({ code: 0, stderr: "" });
    // Not a shipped name (the built-ins folder has no `botling.evil`), a folder named like a built-in whose manifest says
    // another name, the bare family name and a dotted name all keep their refusal.
    for (const [name, folder] of [["botling.evil", "botling.evil"], ["botling.other", "botling.shipped2"], ["botling", "botling"], ["my.plugin", "my.plugin"]] as const) {
      const result = run(plugin(library, name, folder));
      expect(result.code, name).toBe(1);
      expect(result.stdout, name).toMatch(/^✗ name /);
    }
  });

  it("without a folder to check it prints the usage and exits 2", () => {
    expect(setup().run("")).toMatchObject({ code: 2, stderr: "usage: check-plugin <plugin folder>\n" });
  });
});
