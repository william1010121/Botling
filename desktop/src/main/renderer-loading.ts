// Keep the packaged default on its own assets. An external renderer is an explicit developer
// launch option (source or dev trial) or a persisted opt-in for embedded dev-trial artifacts.
import { isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";
import { readRendererConfiguration, validateRendererDirectory } from "../../renderer-config.mjs";
/** What the chat origin serves from out/renderer: the page, its script and styles, and KaTeX's files (the rest is the shell's). */
export const CHAT_FILES = /^\/(?:chat\.html|chat\.js|chat\.js\.map|chat\.css|frame\.css|plugins\/ccb-latex\/(?:katex\.min\.css|fonts\/[A-Za-z0-9_-]+\.woff2))$/;
export interface RendererFiles { directory: string; development: boolean }
export interface RendererConfigurationOptions { appData?: string; warn?: (message: string) => void }
export function rendererFiles(root: string, packaged: boolean, devTrial: boolean, argv: string[],
  options: RendererConfigurationOptions = {}): RendererFiles {
  const bundled = { directory: join(root, "out", "renderer"), development: !packaged };
  // Production must not even read the developer profile, regardless of flags or its contents.
  if (packaged && !devTrial) return bundled;
  const flag = "--botling-renderer-dir=";
  const argument = argv.find(arg => arg.startsWith(flag));
  if (argument !== undefined) return { directory: validateRendererDirectory(argument.slice(flag.length)), development: true };
  if (packaged && devTrial && options.appData) {
    const config = readRendererConfiguration(options.appData);
    if (config.warning) (options.warn || console.warn)(`[renderer] ${config.warning}`);
    if (config.directory) return { directory: config.directory, development: true };
  }
  return bundled;
}
/** Existing protocol handlers still choose the allowed file and CSP; only development caching differs. */
export function rendererResponse(response: Response, development: boolean, csp?: string): Response {
  const headers = new Headers(response.headers);
  if (csp) headers.set("Content-Security-Policy", csp);
  if (development) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
/** Preloads run again whenever their page reloads, so a developer preload build (`npm run
 * preload:build -- --outdir=…`) takes effect on the next shell Cmd+R or Reload Chat Page. Same gate
 * as the renderer directory: source runs and dev-trial artifacts only, an absolute complete build. */
export function preloadFiles(root: string, packaged: boolean, devTrial: boolean, argv: string[]): { directory: string } {
  const bundled = { directory: join(root, "out", "preload") };
  if (packaged && !devTrial) return bundled;
  const flag = "--botling-preload-dir=";
  const argument = argv.find(arg => arg.startsWith(flag));
  if (argument === undefined) return bundled;
  const directory = argument.slice(flag.length);
  if (!isAbsolute(directory)) throw new Error("--botling-preload-dir must be an absolute preload build directory");
  for (const name of ["preload.cjs", "editor-host.cjs"]) {
    try { if (statSync(join(directory, name)).isFile()) continue; } catch { /* report the build action */ }
    throw new Error(`Missing preload ${name}; run npm run preload:build in desktop/ first`);
  }
  return { directory: resolve(directory) };
}
