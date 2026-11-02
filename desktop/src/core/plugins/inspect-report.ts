// `Botling --inspect-plugins list | <query> [<json input>] [--library <dir>]` (ADR-006 M2): the Maintainer's
// read-only window on the plugin world, next to `--check-plugin`. It builds a registry over the library (default:
// the current folder, which is the Maintainer's working folder) and the built-in plugins, runs ONE query from
// introspect.ts and prints JSON. It never writes, holds no secrets (a memory store with nothing in it), and runs
// no shell. Exit code 0: answered; 1: the query or its input was refused; 2: usage.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MemorySecretStore } from "./secrets";
import { PluginRegistry } from "./registry";

export const INSPECT_FLAG = "--inspect-plugins";
const USAGE = `usage: ${INSPECT_FLAG} list | <query> [<json input>] [--library <plugin library folder>]\n`;

export interface InspectEnvironment {
  /** The built-in plugins' folder, if any. */
  builtIns: string | null;
  /** The app's stylesheet (the theme variables), if it can be read. */
  themeCssFile: string | null;
  /** The library when `--library` is not given. */
  cwd: string;
}

export function inspectReport(args: string[], environment: InspectEnvironment): { code: number; stdout: string; stderr: string } {
  const rest = [...args];
  let library = environment.cwd;
  const flag = rest.indexOf("--library");
  if (flag >= 0) { library = rest[flag + 1] ?? ""; rest.splice(flag, 2); }
  const [query, text] = rest;
  if (!query || !library || rest.length > 2) return { code: 2, stdout: "", stderr: USAGE };
  let input: unknown = {};
  if (text !== undefined) {
    try { input = JSON.parse(text); } catch { return { code: 2, stdout: "", stderr: `The input is not valid JSON.\n${USAGE}` }; }
  }
  const root = resolve(library);
  const registry = new PluginRegistry(root, join(dirname(root), "plugins.json"), new MemorySecretStore(), environment.builtIns);
  if (query === "list") return { code: 0, stdout: JSON.stringify({ queries: registry.inspectQueries() }, null, 2) + "\n", stderr: "" };
  let themeCss: string | null = null;
  if (environment.themeCssFile) { try { themeCss = readFileSync(environment.themeCssFile, "utf8"); } catch { /* not available */ } }
  const result = registry.inspect(query, input, { themeCss });
  return { code: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2) + "\n", stderr: "" };
}
