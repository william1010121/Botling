// Bundles Botling 2.0: main (CJS, Node), preload (CJS, sandboxed), core (CJS, utility process),
// renderer (IIFE, browser: the React app page) and the chat frame (IIFE: Web/src's chat page,
// unchanged, plus the desktop's additions). Output goes to out/, which is not committed.
//
// Web/src is bundled from its sources here; its packages (markdown-it, KaTeX, CodeMirror) come
// from desktop/node_modules at the versions Web/package.json pins, so Web/ needs no install and its
// own build output (Sources/ClaudeCodeBot/Resources) is never touched.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRenderer } from "./build-renderer.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
if (process.argv.includes("--watch")) throw new Error("Use npm run renderer:watch; the full build is not a process watcher");
// Trust is embedded at build time; runtime environment variables cannot replace it.
const releaseConfig = JSON.parse(readFileSync(join(here, "release-config.json"), "utf8"));
const updatePublicKey = releaseConfig.publicKey ?? null;
if (updatePublicKey && createPublicKey(updatePublicKey).asymmetricKeyType !== "ed25519") throw new Error("Release public key must be Ed25519");
if (process.env.BOTLING_RELEASE_BUILD === "1" && !updatePublicKey) throw new Error("Release build requires an explicit Ed25519 public key in release-config.json");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "renderer"), { recursive: true });

const web = join(here, "..", "Web");
const node = { bundle: true, platform: "node", format: "cjs", target: "node22", sourcemap: "linked", legalComments: "eof" };
await Promise.all([
  build({ ...node, entryPoints: [join(here, "src/main/main.ts")], outfile: join(out, "main/main.cjs"), external: ["electron"], define: { __UPDATE_PUBLIC_KEY__: JSON.stringify(updatePublicKey) } }),
  build({ ...node, entryPoints: [join(here, "src/preload/preload.ts")], outfile: join(out, "preload/preload.cjs"), external: ["electron"] }),
  // Dormant unprivileged native-editor boundary. No window uses it until coordinated integration.
  build({ ...node, entryPoints: [join(here, "src/preload/editor-host.ts")], outfile: join(out, "preload/editor-host.cjs"), external: ["electron"] }),
  build({ ...node, entryPoints: [join(here, "src/core/main.ts")], outfile: join(out, "core/main.cjs") }),
  // The plugin host: Web/host/src/host.ts unchanged, bundled as Web/build.mjs bundles it for 1.x
  // (its own process, started by the core; see src/core/plugins/host-client.ts).
  build({ entryPoints: [join(web, "host/src/host.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host.mjs") }),
  // The same host in an Electron utility process (main starts it; it talks over a MessagePort).
  build({ entryPoints: [join(here, "src/host/utility.ts")], bundle: true, platform: "node", format: "esm", target: "node20", legalComments: "eof", outfile: join(out, "host/host-utility.mjs") }),
  // `ccb plugin check` for Maintainer (the checks the registry runs), as a small command.
  build({ ...node, entryPoints: [join(here, "src/core/plugins/check-cli.ts")], outfile: join(out, "host/check-plugin.cjs") }),
  buildRenderer({ root: here }),
]);
// The web AIs' page readers as 1.x ships them (Sources/ClaudeCodeBot/Resources/web-extractors, read
// only): the core puts them in the plugin library's ccb-web-extractors and falls back to them.
const extractors = join(here, "..", "Sources", "ClaudeCodeBot", "Resources", "web-extractors");
mkdirSync(join(out, "web-extractors"), { recursive: true });
for (const name of readdirSync(extractors).filter((name) => name.endsWith(".js") || name.endsWith(".md"))) {
  cpSync(join(extractors, name), join(out, "web-extractors", name));
}
console.log("built out/");
