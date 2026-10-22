// Builds web-laas (LaTeX snippets and live preview) for the web bots' web views from a laas-copy
// (web-laas) checkout, into Sources/ClaudeCodeBot/Resources/web-laas. Run through
// scripts/build-web-laas.sh. The extension's own scripts are bundled unchanged:
//   web-laas-main.js      content/main.ts      the page's world: the snippet engine
//   web-laas-isolated.js  content/isolated.ts  the app's world: settings, loads the preview
//   web-laas-preview.js   preview/entry.ts     the app's world, run in a frame on first use (MathJax)
// The isolated-world ones get `chrome` from chrome-shim.js, and csp-styles.js keeps their styles
// on pages whose CSP refuses inline <style>. THIRD_PARTY_NOTICES.txt lists every
// package in the bundles, with its license text, from esbuild's own list of inputs.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const source = path.resolve(process.argv[2] ?? "");
const pkg = path.join(source, "packages/web-laas");
if (!existsSync(path.join(pkg, "src/content/main.ts"))) {
  console.error(`Not a web-laas (laas-copy) checkout: ${source}`);
  process.exit(1);
}
const out = path.join(repo, "Sources/ClaudeCodeBot/Resources/web-laas");
const esbuild = createRequire(path.join(source, "package.json"))("esbuild");

const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--", "packages") !== "";
const version = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8")).version;
const stamp = `${commit.slice(0, 12)}${dirty ? "-dirty" : ""}`;
const header = [
  `// web-laas ${version} (GPL-3.0-or-later, https://github.com/william1010121/web-laas)`,
  `// built from commit ${commit}${dirty ? " with uncommitted changes in packages/" : ""}`,
  `// by scripts/build-web-laas.sh; do not edit. Third-party licenses: THIRD_PARTY_NOTICES.txt`,
].join("\n");

const common = {
  absWorkingDir: pkg,
  bundle: true,
  format: "iife",
  target: "safari16",
  loader: { ".laas": "text" },
  conditions: ["source"],
  // identifies this build to main.ts, which hands over to a different one in the same page
  define: { __WEB_LAAS_BUILD__: JSON.stringify(`ccb-${stamp}`) },
  banner: { js: header },
  legalComments: "none",
  minify: true,
  metafile: true,
  logLevel: "warning",
};
const isolated = { inject: [path.join(here, "chrome-shim.js"), path.join(here, "csp-styles.js")] };
const builds = [
  { entryPoints: ["src/content/main.ts"], outfile: path.join(out, "web-laas-main.js") },
  { entryPoints: ["src/content/isolated.ts"], outfile: path.join(out, "web-laas-isolated.js"), ...isolated },
  { entryPoints: ["src/preview/entry.ts"], outfile: path.join(out, "web-laas-preview.js"), ...isolated },
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const inputs = new Set();
for (const b of builds) {
  const result = await esbuild.build({ ...common, ...b });
  for (const file of Object.keys(result.metafile.inputs)) inputs.add(path.resolve(pkg, file));
}

// Every package a bundled file belongs to: the nearest package.json above it, outside this repo.
const packages = new Map();
for (const file of inputs) {
  if (file.startsWith(here)) continue;
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir) && !existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
  const meta = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  // (a nested package.json that only sets "type" belongs to the package above it)
  if (!meta.name) {
    let up = path.dirname(dir);
    while (!existsSync(path.join(up, "package.json")) || !JSON.parse(readFileSync(path.join(up, "package.json"), "utf8")).name) up = path.dirname(up);
    dir = up;
  }
  if (!packages.has(dir)) packages.set(dir, JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")));
}
const licenseText = (dir) => {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  if (file) return readFileSync(path.join(dir, file), "utf8").trim();
  return null;
};
const sections = [...packages]
  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
  .map(([dir, meta]) => {
    const license = typeof meta.license === "string" ? meta.license : meta.license?.type ?? "UNKNOWN";
    const where = meta.repository?.url ?? meta.repository ?? meta.homepage ?? "";
    const text = license.startsWith("GPL-3.0")
      ? "The GNU General Public License v3.0: see LICENSE at the top of ClaudeCodeBot's source, or https://www.gnu.org/licenses/gpl-3.0.txt"
      : licenseText(dir) ?? `(no license file in the package; its package.json says ${license})`;
    return [`${meta.name} ${meta.version ?? ""}`.trim(), `License: ${license}`, where && `Source: ${where}`, "", text].filter((l) => l !== false && l !== null).join("\n");
  });
writeFileSync(
  path.join(out, "THIRD_PARTY_NOTICES.txt"),
  [
    "Third-party software in ClaudeCodeBot's web-laas scripts (LaTeX snippets and live preview in",
    "the web bots), bundled into web-laas-*.js by scripts/build-web-laas.sh.",
    `web-laas ${version}, commit ${commit}${dirty ? " (with uncommitted changes)" : ""}.`,
    "",
    ...sections.flatMap((s) => ["=".repeat(78), s, ""]),
  ].join("\n"),
);

for (const b of builds) console.log(`${path.relative(repo, b.outfile)}  ${(readFileSync(b.outfile).length / 1024).toFixed(0)} KB`);
console.log(`packages: ${[...packages.values()].map((m) => `${m.name} (${m.license})`).join(", ")}`);
console.log(`web-laas ${version} @ ${stamp}`);
