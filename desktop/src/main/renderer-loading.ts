// Keep the packaged default on its own assets. An external renderer is an explicit developer
// launch option (source or dev trial) or a persisted opt-in for embedded dev-trial artifacts.
import { join } from "node:path";
import { readRendererConfiguration, validateRendererDirectory } from "../../renderer-config.mjs";
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
