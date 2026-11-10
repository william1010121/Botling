// One run of a site tool on a page (browser-site-tools.ts): the script in its own isolated world, its progress line
// read while it runs, a time limit, what it gave back checked, and each file it asked to save handed to `save`
// (main's save dialog). Free of Electron: browser-host.ts gives it the page's `exec` and the dialog.
import { basename } from "node:path";
import {
  PROGRESS_GLOBAL, RUN_TIMEOUT_MS, parseRunOutput, worldIdOf, wrapScript,
  type RunFile, type SiteTool, type SiteToolOptions,
} from "../browser-site-tools";

export interface SiteToolRunInput {
  tool: SiteTool;
  options: SiteToolOptions;
  /** Toggle tools: on or off; null for an action tool. */
  active: boolean | null;
  /** Runs code in an isolated world of the page and gives back its (awaited) value. */
  exec(worldId: number, code: string): Promise<unknown>;
  /** Saves a file the tool asked for; its path, or null when the person did not save it. */
  save?(file: RunFile): Promise<string | null>;
  onProgress?(text: string): void;
  timeoutMs?: number;
  pollMs?: number;
}
export interface SiteToolRunResult { ok: boolean; text: string; saved: string[]; active: boolean | null }

export async function runSiteTool(input: SiteToolRunInput): Promise<SiteToolRunResult> {
  const world = worldIdOf(input.tool.id);
  const code = wrapScript(input.tool, { options: input.options, active: input.active });
  let done = false;
  let last: string | null = null;
  const poll = input.onProgress ? setInterval(() => {
    if (done) return;
    void input.exec(world, `globalThis.${PROGRESS_GLOBAL} ?? null`).then((value) => {
      if (!done && typeof value === "string" && value !== last) { last = value; input.onProgress!(value.slice(0, 200)); }
    }, () => {});
  }, input.pollMs ?? 400) : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = input.timeoutMs ?? RUN_TIMEOUT_MS;
  let raw: unknown;
  try {
    raw = await Promise.race([
      input.exec(world, code),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`stopped after ${Math.round(limit / 1000)} s`)), limit); }),
    ]);
  } catch (error) {
    return { ok: false, text: `Failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`, saved: [], active: null };
  } finally {
    done = true;
    if (poll) clearInterval(poll);
    if (timer) clearTimeout(timer);
  }
  const output = parseRunOutput(raw);
  if ("invalid" in output) return { ok: false, text: `Failed: ${output.invalid}`, saved: [], active: null };
  if (output.error) return { ok: false, text: output.error, saved: [], active: output.active };
  const saved: string[] = [];
  let skipped = 0;
  for (const file of output.files) {
    const path = input.save ? await input.save(file) : null;
    if (path) saved.push(path); else skipped++;
  }
  const parts: string[] = [];
  if (output.result) parts.push(output.result);
  if (saved.length) parts.push(`Saved ${saved.map((path) => basename(path)).join(", ")}`);
  if (skipped) parts.push(skipped === output.files.length ? "Not saved" : `${skipped} not saved`);
  return { ok: true, text: parts.join(" · ") || "Done", saved, active: output.active };
}
