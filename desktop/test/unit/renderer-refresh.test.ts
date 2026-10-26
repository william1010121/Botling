import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
const script = resolve("build-renderer.mjs");
// Runtime import of the same ESM module used by both build entry points.
const { buildRenderer, watchRenderer } = await import(script);
const roots: string[] = [], stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "botling-renderer-refresh-")); roots.push(repo);
  const root = join(repo, "desktop"), outdir = join(root, "out/renderer");
  const put = (path: string, body: string) => { const file = join(repo, path); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, body); };
  put("desktop/src/renderer/main.tsx", 'globalThis.shellVersion = "shell-one"; globalThis.mode = process.env.NODE_ENV;');
  put("desktop/src/renderer/chat-frame/entry.ts", 'globalThis.chatVersion = "chat-one"; globalThis.latex = __LATEX_SOURCE__;');
  put("desktop/src/renderer/index.html", '<div id="root"></div><script src="renderer.js"></script>');
  put("desktop/src/renderer/styles.css", '@import "../../../Web/src/tokens.css";\n.shell { color: red; }');
  put("desktop/src/renderer/chat-frame/chat.html", '<script src="chat.js"></script>');
  put("desktop/src/renderer/chat-frame/frame.css", '.frame { color: red; }');
  put("Web/src/chat.css", '@import "tokens.css";\n.chat { color: red; }');
  put("Web/src/tokens.css", ':root { --token: red; }');
  put("Web/plugins/ccb-latex/src/web.ts", 'export const version = "latex-one";');
  put("desktop/out/main/main.cjs", 'main must stay running');
  put("desktop/out/core/main.cjs", 'core must stay running');
  put("desktop/out/preload/preload.cjs", 'preload must stay unchanged');
  mkdirSync(join(repo, "Web/kit/generated"), { recursive: true });
  mkdirSync(join(repo, "Sources/ClaudeCodeBotCore/Resources/CharacterArt/avatars-static"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  return { repo, root, outdir, put, read: (file: string) => readFileSync(join(outdir, file), "utf8") };
}
it("renderer-only publication keeps main/core/preload output and retains successful assets after a failed build", async () => {
  const f = fixture(); await buildRenderer(f);
  expect(f.read("renderer.js")).toContain("shell-one");
  const production: Record<string, unknown> = {}; runInNewContext(f.read("renderer.js"), production);
  expect(production.mode).toBe("production");
  expect(f.read("chat.js")).toContain("chat-one");
  expect(f.read("styles.css")).toContain("--token: red");
  expect(f.read("plugins/ccb-latex/katex.min.css")).toContain("KaTeX");
  const original = f.read("renderer.js");
  f.put("desktop/src/renderer/main.tsx", "const broken = ;");
  await expect(buildRenderer(f)).rejects.toThrow();
  expect(f.read("renderer.js")).toBe(original);
  f.put("desktop/src/renderer/main.tsx", 'globalThis.shellVersion = "shell-two";');
  rmSync(join(f.root, "src/renderer/styles.css"));
  await expect(buildRenderer(f)).rejects.toThrow();
  expect(f.read("renderer.js")).toBe(original);
  for (const [path, text] of [["main/main.cjs", "main must stay running"], ["core/main.cjs", "core must stay running"], ["preload/preload.cjs", "preload must stay unchanged"]])
    expect(readFileSync(join(f.root, "out", path), "utf8")).toBe(text);
});
it("one watcher publishes TS, HTML, token CSS and chat changes, then recovers from a syntax error", async () => {
  const f = fixture(), builds: string[] = [], errors: Error[] = [];
  stops.push(await watchRenderer({ ...f, interval: 25, onBuild: (dir: string) => builds.push(dir), onError: (error: Error) => errors.push(error) }));
  expect(builds).toHaveLength(1);
  const development: Record<string, unknown> = {}; runInNewContext(f.read("renderer.js"), development);
  expect(development.mode).toBe("development");
  // Match an editor's atomic save instead of relying on an existing inode watch.
  f.put("desktop/src/renderer/main.tsx.new", 'import "./new/view"; globalThis.shellVersion = "shell-two";');
  f.put("desktop/src/renderer/new/view.ts", 'globalThis.addedModule = "new-directory";');
  renameSync(join(f.root, "src/renderer/main.tsx.new"), join(f.root, "src/renderer/main.tsx"));
  f.put("desktop/src/renderer/index.html", '<main>updated html</main>');
  f.put("Web/src/tokens.css", ':root { --token: blue; }');
  f.put("desktop/src/renderer/chat-frame/entry.ts", 'globalThis.chatVersion = "chat-two"; globalThis.latex = __LATEX_SOURCE__;');
  f.put("Web/plugins/ccb-latex/src/web.ts", 'export const version = "latex-two";');
  await expect.poll(() => f.read("renderer.js")).toContain("shell-two");
  expect(f.read("renderer.js")).toContain("new-directory");
  expect(f.read("index.html")).toContain("updated html");
  expect(f.read("styles.css")).toContain("--token: blue");
  expect(f.read("chat.css")).toContain("--token: blue");
  expect(f.read("chat.js")).toContain("chat-two");
  expect(f.read("chat.js")).toContain("latex-two");
  const previous = f.read("renderer.js");
  f.put("desktop/src/renderer/main.tsx", "const broken = ;");
  await expect.poll(() => errors.length).toBeGreaterThan(0);
  expect(f.read("renderer.js")).toBe(previous);
  f.put("desktop/src/renderer/main.tsx", 'globalThis.shellVersion = "shell-three";');
  await expect.poll(() => f.read("renderer.js")).toContain("shell-three");
  expect(builds.length).toBeGreaterThanOrEqual(3);
});
