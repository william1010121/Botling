import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preloadFiles, rendererFiles, rendererResponse } from "../../src/main/renderer-loading";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botling-renderer-load-")); roots.push(root);
  const directory = join(root, "external"); mkdirSync(directory);
  for (const name of ["index.html", "renderer.js", "styles.css", "chat.html", "chat.js", "chat.css", "frame.css"])
    writeFileSync(join(directory, name), name);
  return { root, directory, argv: [`--botling-renderer-dir=${directory}`] };
}
it("ordinary packaged launches keep their bundled files, even with a missing or invalid developer override", () => {
  const f = fixture();
  for (const argv of [[], f.argv, ["--botling-renderer-dir=relative"], ["--botling-renderer-dir=/absent"]])
    expect(rendererFiles(f.root, true, false, argv)).toEqual({ directory: join(f.root, "out/renderer"), development: false });
});
it("source and dev-trial launches opt into an absolute, complete build without moving the app origin", () => {
  const f = fixture();
  for (const packaged of [false, true])
    expect(rendererFiles(f.root, packaged, true, f.argv)).toEqual({ directory: f.directory, development: true });
  expect(rendererFiles(f.root, true, true, [])).toEqual({ directory: join(f.root, "out/renderer"), development: false });
  expect(rendererFiles(f.root, false, false, []).development).toBe(true);
  expect(() => rendererFiles(f.root, false, false, ["--botling-renderer-dir=relative"])).toThrow("absolute");
  rmSync(join(f.directory, "chat.js"));
  expect(() => rendererFiles(f.root, true, true, f.argv)).toThrow("npm run renderer:build");
});
it("successive development loads read changed bytes without caching and retain the existing CSP/type", async () => {
  const f = fixture(), file = join(f.directory, "renderer.js");
  const load = () => rendererResponse(new Response(readFileSync(file), {
    headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=3600" },
  }), true, "default-src 'none'; script-src 'self'");
  const before = load(); expect(await before.text()).toBe("renderer.js");
  writeFileSync(file, "updated shell");
  const after = load(); expect(await after.text()).toBe("updated shell");
  expect(after.headers.get("Cache-Control")).toBe("no-store");
  expect(after.headers.get("Content-Type")).toBe("text/javascript");
  expect(after.headers.get("Content-Security-Policy")).toBe("default-src 'none'; script-src 'self'");
  const packaged = rendererResponse(new Response("bundled", { headers: { "Cache-Control": "max-age=3600" } }), false);
  expect(packaged.headers.get("Cache-Control")).toBe("max-age=3600");
  expect(await packaged.text()).toBe("bundled");
});
function preloadFixture() {
  const root = mkdtempSync(join(tmpdir(), "botling-preload-load-")); roots.push(root);
  const directory = join(root, "dev-preload"); mkdirSync(directory);
  for (const name of ["preload.cjs", "editor-host.cjs"]) writeFileSync(join(directory, name), name);
  return { root, directory, argv: [`--botling-preload-dir=${directory}`] };
}
it("preloads come from the bundle unless a source or dev-trial launch names a complete developer preload build", () => {
  const f = preloadFixture();
  for (const argv of [[], f.argv]) expect(preloadFiles(f.root, true, false, argv)).toEqual({ directory: join(f.root, "out/preload") });
  expect(preloadFiles(f.root, true, true, [])).toEqual({ directory: join(f.root, "out/preload") });
  for (const packaged of [false, true]) expect(preloadFiles(f.root, packaged, true, f.argv)).toEqual({ directory: f.directory });
  expect(() => preloadFiles(f.root, false, false, ["--botling-preload-dir=relative"])).toThrow("absolute");
  rmSync(join(f.directory, "editor-host.cjs"));
  expect(() => preloadFiles(f.root, true, true, f.argv)).toThrow("npm run preload:build");
});
