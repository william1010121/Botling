#!/usr/bin/env node
// Writes index.json: one entry per plugin folder (a folder at the repo root with a package.json).
//
//   node tools/build-index.mjs           regenerate index.json
//   node tools/build-index.mjs --check   exit 1 if index.json is out of date (CI)
//   node tools/build-index.mjs --set-commit <sha>   also fill every empty "commit" with <sha>
//                                       (the commit that holds the folders as they are now)
//
// "sha256" is the hash of the folder's contents: for every file, sorted by path,
// "<path>\0<sha256 of the file>\n", hashed again. "commit" is kept as it is in the current
// index.json (empty until a release commit is recorded for that plugin with --set-commit).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const setAt = process.argv.indexOf("--set-commit");
const setCommit = setAt >= 0 ? process.argv[setAt + 1] : null;
if (setAt >= 0 && !/^[0-9a-f]{40}$/.test(setCommit ?? "")) { console.error("--set-commit needs a full 40-character commit hash"); process.exit(2); }
const sha = (data) => createHash("sha256").update(data).digest("hex");
const listFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)]);
const posix = (p) => p.split(sep).join("/");

const indexPath = join(root, "index.json");
const old = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { plugins: [] };
const oldCommit = new Map((old.plugins ?? []).map((p) => [p.name, p.commit ?? ""]));

const folders = readdirSync(root, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "tools" && existsSync(join(root, e.name, "package.json")))
  .map((e) => e.name).sort();

const plugins = folders.map((folder) => {
  const dir = join(root, folder);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = listFiles(dir).map((f) => posix(relative(dir, f))).sort();
  const size = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  const digest = sha(files.map((f) => `${f}\0${sha(readFileSync(join(dir, f)))}\n`).join(""));
  const engines = pkg.engines?.ccb ?? null;
  const min = engines && /(\d+\.\d+\.\d+)/.exec(engines)?.[1];
  const ccb = pkg.ccb ?? {};
  const parts = [ccb.web && "web", ccb.host && "host", ccb.claude && "claude", ccb.contributes?.components && "components"].filter(Boolean);
  const componentsDir = ccb.contributes?.components ? join(dir, ccb.contributes.components) : null;
  const entry = {
    name: pkg.name,
    displayName: pkg.displayName ?? pkg.name,
    description: pkg.description ?? "",
    version: pkg.version,
    license: pkg.license ?? null,
    licenseFile: ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"].find((f) => existsSync(join(dir, f))) ?? null,
    permissions: ccb.permissions ?? [],
    engines: pkg.engines ?? {},
    minAppVersion: min ?? null,
    parts,
    path: folder,
    files: files.length,
    size,
    sha256: digest,
    commit: oldCommit.get(pkg.name) || setCommit || "",
  };
  if (componentsDir && existsSync(componentsDir)) entry.components = readdirSync(componentsDir).filter((n) => statSync(join(componentsDir, n)).isDirectory()).sort();
  if (pkg.name !== folder) throw new Error(`${folder}: package.json name is ${pkg.name}; the folder must be named like the plugin`);
  return entry;
});

const text = JSON.stringify({ schema: 1, repo: "botling-plugins", plugins }, null, 2) + "\n";
if (check) {
  const current = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  if (current !== text) { console.error("index.json is out of date: run node tools/build-index.mjs and commit it."); process.exit(1); }
  console.log(`index.json is up to date (${plugins.length} plugins).`);
} else {
  writeFileSync(indexPath, text);
  console.log(`index.json: ${plugins.length} plugins.`);
}
