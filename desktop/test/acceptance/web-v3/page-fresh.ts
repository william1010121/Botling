// The page tests run the built page (web-v3/dist, git-ignored, made only by `node web-v3/build.mjs`). A dist older than
// its sources (after a rebase, a merge or an edit without a rebuild) tests old code and has given false failures, so the
// page harness refuses to start on one. web-v3/build.mjs writes `<dist>.inputs.json` last, with `sources`: every file
// the build read (the bundles' inputs, the copied assets, build.mjs itself), so its mtime is the build's time.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const PAGE_DIST = join(__dirname, "../../../web-v3/dist");
export const REBUILD = "npm run build && node web-v3/build.mjs";

/** Why `dist` is stale (the first source newer than the build, or a missing record), or null when it is fresh. */
export function pageStaleness(dist = PAGE_DIST): string | null {
  const record = `${dist}.inputs.json`;
  if (!existsSync(record)) return `${record} is missing`;
  const built = statSync(record).mtimeMs;
  let sources: unknown;
  try { sources = (JSON.parse(readFileSync(record, "utf8")) as { sources?: unknown }).sources; } catch { return `${record} is unreadable`; }
  if (!Array.isArray(sources)) return `${record} has no source list (made by an older web-v3/build.mjs)`;
  const base = join(dist, "../..");
  for (const source of sources as string[]) {
    let mtime: number;
    try { mtime = statSync(source).mtimeMs; } catch { return `${relative(base, source)} was read by the build and is gone`; }
    if (mtime > built) return `${relative(base, source)} changed ${Math.round((mtime - built) / 1000)} s after the build`;
  }
  return null;
}

/** Throws when an existing `dist` is older than its sources. A missing dist is left to the tests' own skip. */
export function assertPageFresh(dist = PAGE_DIST): void {
  if (!existsSync(dist)) return;
  const why = pageStaleness(dist);
  if (why) throw new Error(`web-v3/dist is stale: ${why}. Rebuild it from desktop/ before the page tests: ${REBUILD}`);
}
