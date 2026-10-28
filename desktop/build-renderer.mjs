// Renderer-only builds never remove out/ or touch main, core, preloads or the plugin host.
import { build } from "esbuild";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inlineTokens } from "../Web/kit/build.mjs";

export const desktopRoot = dirname(fileURLToPath(import.meta.url));
/** `web: true` builds Botling Web (desktop/mobile/): the same renderer and chat page, with
 * desktop/mobile/main.tsx as the shell's entry (web.js) and __BOTLING_WEB__ set for both pages. */
export async function buildRenderer({ root = desktopRoot, outdir = join(root, "out/renderer"), development = false, web: webBuild = false } = {}) {
  outdir = resolve(outdir);
  const web = join(root, "../Web"), nodePaths = [join(root, "node_modules")];
  const latex = await build({ entryPoints: [join(web, "plugins/ccb-latex/src/web.ts")], bundle: true,
    format: "esm", target: "chrome130", minify: true, legalComments: "eof", write: false, nodePaths });
  const characters = {};
  const art = join(root, "../Sources/ClaudeCodeBotCore/Resources/CharacterArt/avatars-static");
  for (const character of ["claude", "gpt", "gemini"]) {
    characters[character] = {};
    for (const expression of ["idle", "working", "thinking", "sleepy"]) {
      try { characters[character][expression] = readFileSync(join(art, character, `${expression}.png`)).toString("base64"); } catch { /* original look */ }
    }
  }
  const browser = { bundle: true, format: "iife", target: "chrome130", minify: !development,
    sourcemap: "linked", legalComments: "eof", write: false, nodePaths };
  const bundles = await Promise.all([
    build({ ...browser, entryPoints: [join(root, webBuild ? "mobile/main.tsx" : "src/renderer/main.tsx")], outfile: join(outdir, webBuild ? "web.js" : "renderer.js"),
      jsx: "automatic", define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production"), __CHARACTERS__: JSON.stringify(characters), __BOTLING_WEB__: JSON.stringify(webBuild) } }),
    build({ ...browser, entryPoints: [join(root, "src/renderer/chat-frame/entry.ts")], outfile: join(outdir, "chat.js"),
      define: { __LATEX_SOURCE__: JSON.stringify(latex.outputFiles[0].text), __BOTLING_WEB__: JSON.stringify(webBuild) } }),
  ]);
  // Read every input before publication. A syntax/missing-asset error keeps the last successful build.
  const files = new Map(bundles.flatMap(result => result.outputFiles.map(file => [file.path, file.contents])));
  const asset = (from, to, tokens = false) => files.set(join(outdir, to), tokens
    ? inlineTokens(readFileSync(from, "utf8"), from) : readFileSync(from));
  if (webBuild) {
    for (const name of ["index.html", "web.css", "manifest.webmanifest", "icon.svg", "frame-host.html", "frame-host.js"]) asset(join(root, "mobile", name), name);
  } else asset(join(root, "src/renderer/index.html"), "index.html");
  asset(join(root, "src/renderer/styles.css"), "styles.css", true);
  asset(join(root, "src/renderer/chat-frame/chat.html"), "chat.html");
  asset(join(root, "src/renderer/chat-frame/frame.css"), "frame.css");
  asset(join(web, "src/chat.css"), "chat.css", true);
  const katex = join(root, "node_modules/katex/dist");
  asset(join(katex, "katex.min.css"), "plugins/ccb-latex/katex.min.css");
  for (const name of readdirSync(join(katex, "fonts")).filter(name => name.endsWith(".woff2")))
    asset(join(katex, "fonts", name), `plugins/ccb-latex/fonts/${name}`);
  for (const [file, contents] of files) {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, contents); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
  }
  return outdir;
}

// Poll source metadata: works across editor atomic-save/rename and newly created directories,
// requires no HTTP server, injected script, socket or change to either renderer's CSP.
export function rendererStamp(root = desktopRoot) {
  const rows = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const stat = statSync(file);
        rows.push(`${file}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
      }
    }
  };
  for (const directory of ["src", "../Web/src", "../Web/plugins/ccb-latex/src", "../Web/kit/generated",
    "../Sources/ClaudeCodeBotCore/Resources/CharacterArt/avatars-static"]) visit(join(root, directory));
  return rows.sort().join("\n");
}
export async function watchRenderer({ root = desktopRoot, outdir = join(root, "out/renderer"), interval = 300,
  onBuild = directory => console.log(`[renderer] ready: ${directory} — Cmd+R reloads the shell; native chat stays alive`),
  onError = error => console.error(`[renderer] build failed; keeping last successful output: ${error.message}`) } = {}) {
  let stopped = false, timer, previous;
  const tick = async () => {
    if (stopped) return;
    try {
      const stamp = rendererStamp(root);
      if (stamp !== previous) {
        previous = stamp;
        await buildRenderer({ root, outdir, development: true });
        onBuild(resolve(outdir));
      }
    } catch (error) { onError(error); }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  await tick();
  return () => { stopped = true; clearTimeout(timer); };
}
