// Bundles the chat surface into the app's resources (chat.html, chat.js, chat.css; viewer.html and
// viewer.js, the file window for .md files, share chat.css), and each
// built-in plugin in plugins/ into Resources/plugins/<name>/ (package.json, its bundles, and what
// its own build.json says to copy), and the Node plugin host into Resources/host/host.mjs. Output
// is committed so `swift build` needs no npm.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resources = join(here, "../Sources/ClaudeCodeBot/Resources");
const out = join(resources, "web");
const pluginsOut = join(resources, "plugins");

rmSync(out, { recursive: true, force: true });
rmSync(pluginsOut, { recursive: true, force: true });
rmSync(join(resources, "host"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  format: "iife",
  target: "safari17",
  minify: true,
  legalComments: "eof",
  outfile: join(out, "chat.js"),
});
await build({
  entryPoints: [join(here, "src/viewer.ts")],
  bundle: true,
  format: "iife",
  target: "safari17",
  minify: true,
  legalComments: "eof",
  outfile: join(out, "viewer.js"),
});
await build({
  entryPoints: [join(here, "host/src/host.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "eof",
  outfile: join(resources, "host/host.mjs"),
});
cpSync(join(here, "src/chat.html"), join(out, "chat.html"));
cpSync(join(here, "src/chat.css"), join(out, "chat.css"));
cpSync(join(here, "src/viewer.html"), join(out, "viewer.html"));

/**
 * Copies what a plugin's build.json lists beside its bundles: `copy` [{from, to, only?}], `from`
 * relative to Web/ (a file or a folder; `only` keeps a folder's files with that ending), `to`
 * relative to the plugin's output folder.
 */
function copyDeclared(source, target) {
  const file = join(source, "build.json");
  if (!existsSync(file)) return;
  const declared = JSON.parse(readFileSync(file, "utf8"));
  for (const { from, to, only } of declared.copy ?? []) {
    const origin = join(here, from);
    const destination = join(target, to);
    if (statSync(origin).isDirectory() && only) {
      mkdirSync(destination, { recursive: true });
      for (const name of readdirSync(origin).filter((entry) => entry.endsWith(only))) {
        cpSync(join(origin, name), join(destination, name));
      }
    } else {
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(origin, destination, { recursive: true });
    }
  }
}

for (const name of readdirSync(join(here, "plugins"))) {
  const source = join(here, "plugins", name);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const target = join(pluginsOut, name);
  mkdirSync(join(target, "dist"), { recursive: true });
  cpSync(join(source, "package.json"), join(target, "package.json"));
  if (manifest.ccb?.host) {
    await build({
      entryPoints: [join(source, "src/host.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      outfile: join(target, manifest.ccb.host),
    });
  }
  if (manifest.ccb?.web) {
    await build({
      entryPoints: [join(source, "src/web.ts")],
      bundle: true,
      format: "esm",
      target: "safari17",
      minify: true,
      legalComments: "eof",
      outfile: join(target, manifest.ccb.web),
    });
  }
  copyDeclared(source, target);
}
console.log("built", out, pluginsOut);
