// A plugin's web part from the row, for the frames (M7-09b). The 2.x window's frames take a plugin's code from `plugins.web` (the chat
// frame's specs) and `plugins.panel` (a panel's `source`). When the plugin's row in the attached server's own table names its web
// bundle (`files.web`, M7-09a), the adapter answers with the bytes of that reference instead: the same bytes the kernel's row loader
// runs (renderer/shell/row-loader.ts), hash-checked. A row with no reference, a bundle that cannot be had, or an adapter with no
// fetcher leaves the server's own answer as it was (`plugins.web` stays the fallback).
//
// The plugin whose bundle is asked for is the one the frame's own spec (or panel command) names, checked as a plugin name; its row is
// read at that moment. Pure TypeScript: no Electron, no Node built-ins.
import { PluginRow } from "../protocol/table-rows";
import { webRefOf, type BundleFetcher } from "../renderer/shell/row-loader";

const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,213}$/;

/** What a row says about a plugin's web part: the code it is and the reference, or null (no such row, no reference). */
export function rowWeb(rows: ReadonlyMap<string, unknown> | undefined, name: string): { ref: string; key: string } | null {
  if (!rows || typeof name !== "string" || !PLUGIN_NAME.test(name)) return null;
  const parsed = PluginRow.safeParse(rows.get(`plugin:${name}`));
  if (!parsed.success) return null;
  const ref = webRefOf(parsed.data.files);
  return ref ? { ref, key: `${parsed.data.codeHash}|${ref}` } : null;
}

export interface BySource {
  fetch: BundleFetcher | undefined;
  /** The attached server's own rows as they are now (read again after each fetch: a row may move while its bundle is read). */
  rows: () => ReadonlyMap<string, unknown> | undefined;
  /** One clean line when a bundle was not had (the server's source is used then). */
  log: (line: string) => void;
}

/** The bundle of plugin `name` by its row's reference, and the row's key (code hash and reference); null when the server's source stays. */
// A row that moves while its bundle is read is read again (L-008): a slower fetch of the old bundle never answers for the new row.
const MOVES_FOLLOWED = 3;

export async function sourceByRef(by: BySource, name: string): Promise<{ source: string; key: string } | null> {
  if (!by.fetch) return null;
  for (let tries = 0; tries < MOVES_FOLLOWED; tries++) {
    const web = rowWeb(by.rows(), name);
    if (!web) return null;
    let source: string;
    try {
      source = await by.fetch({ plugin: name, ref: web.ref });
    } catch (error) {
      by.log(`the web part of ${JSON.stringify(name.slice(0, 80))} was not read by its reference; the server's source is used: ${JSON.stringify(String((error as Error)?.message ?? error).slice(0, 120))}`);
      return null;
    }
    if (rowWeb(by.rows(), name)?.key === web.key) return { source, key: web.key };
  }
  by.log(`the row of ${JSON.stringify(name.slice(0, 80))} kept moving while its web part was read; the server's source is used`);
  return null;
}

/** The `plugins.web` answer with each spec's `source` from its row's bundle where the row names one; `served` gets the key of each. */
export async function specsByRef(answer: unknown, by: BySource, served: Map<string, string>): Promise<unknown> {
  const specs = (answer as { specs?: unknown } | null)?.specs;
  if (!Array.isArray(specs)) return answer;
  const next = await Promise.all(specs.map(async (spec: unknown) => {
    const name = (spec as { name?: unknown } | null)?.name;
    if (typeof name !== "string") return spec;
    const found = await sourceByRef(by, name);
    if (!found) return spec;
    served.set(name, found.key);
    return { ...(spec as object), source: found.source };
  }));
  return { ...(answer as object), specs: next };
}

/** The `plugins.panel` answer with its `source` from the row's bundle where the row names one. */
export async function panelByRef(answer: unknown, by: BySource, name: string, served: Map<string, string>): Promise<unknown> {
  if (!answer || typeof answer !== "object" || typeof (answer as { source?: unknown }).source !== "string") return answer;
  const found = await sourceByRef(by, name);
  if (!found) return answer;
  served.set(name, found.key);
  return { ...(answer as object), source: found.source };
}
