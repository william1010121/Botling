// `npm run preload:build`: only the two preloads, published atomically, so the next page reload
// (shell Cmd+R, or View → Reload Chat Page for the native chat) runs the new code without an app restart.
import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const { buildPreloads } = await import(resolve("build-preloads.mjs"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "botling-preload-build-")); roots.push(root);
  const put = (path: string, body: string) => { const file = join(root, path); mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, body); };
  put("src/preload/preload.ts", 'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("v", "shell-one");');
  put("src/preload/editor-host.ts", 'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("v", "editor-one");');
  put("out/main/main.cjs", "main must stay");
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  return { root, put, outdir: join(root, "dev-preload") };
}
it("builds both preloads into a chosen directory, leaves the rest of out/ alone, and keeps the last good build on error", async () => {
  const f = fixture();
  await buildPreloads({ root: f.root, outdir: f.outdir });
  const read = (name: string) => readFileSync(join(f.outdir, name), "utf8");
  expect(read("preload.cjs")).toContain("shell-one");
  expect(read("editor-host.cjs")).toContain("editor-one");
  expect(read("preload.cjs")).toContain('require("electron")');
  expect(readFileSync(join(f.root, "out/main/main.cjs"), "utf8")).toBe("main must stay");
  f.put("src/preload/editor-host.ts", 'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("v", "editor-two");');
  await buildPreloads({ root: f.root, outdir: f.outdir });
  expect(read("editor-host.cjs")).toContain("editor-two");
  f.put("src/preload/editor-host.ts", "this is not ( typescript");
  await expect(buildPreloads({ root: f.root, outdir: f.outdir })).rejects.toThrow();
  expect(read("editor-host.cjs")).toContain("editor-two");
  expect(existsSync(join(f.outdir, "out"))).toBe(false);
});
