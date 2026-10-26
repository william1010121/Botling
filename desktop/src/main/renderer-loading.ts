// Keep the packaged default on its own assets. An external renderer is an explicit developer
// launch option, available only to source runs and artifacts marked botlingDevTrial at build time.
import { isAbsolute, join, resolve } from "node:path";
import { statSync } from "node:fs";
export interface RendererFiles { directory: string; development: boolean }
export function rendererFiles(root: string, packaged: boolean, devTrial: boolean, argv: string[]): RendererFiles {
  const bundled = { directory: join(root, "out", "renderer"), development: !packaged };
  if (packaged && !devTrial) return bundled;
  const flag = "--botling-renderer-dir=";
  const argument = argv.find(arg => arg.startsWith(flag));
  if (argument === undefined) return bundled;
  const directory = argument.slice(flag.length);
  if (!isAbsolute(directory)) throw new Error("--botling-renderer-dir must be an absolute renderer build directory");
  for (const name of ["index.html", "renderer.js", "styles.css", "chat.html", "chat.js", "chat.css", "frame.css"]) {
    try { if (statSync(join(directory, name)).isFile()) continue; } catch { /* report the build action */ }
    throw new Error(`Missing renderer asset ${name}; run npm run renderer:build in desktop/ first`);
  }
  return { directory: resolve(directory), development: true };
}
/** Existing protocol handlers still choose the allowed file and CSP; only development caching differs. */
export function rendererResponse(response: Response, development: boolean, csp?: string): Response {
  const headers = new Headers(response.headers);
  if (csp) headers.set("Content-Security-Policy", csp);
  if (development) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
