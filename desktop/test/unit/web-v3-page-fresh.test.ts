// The page tests' freshness guard (test/acceptance/web-v3/page-fresh.ts): a web-v3/dist older than any file its build
// read is refused with the rebuild command; a missing dist is left to the tests' own skip. Temp files only, no build.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPageFresh, pageStaleness, REBUILD } from "../acceptance/web-v3/page-fresh";

describe("web-v3 page freshness guard", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function layout(sources?: string[]): { dist: string; src: string; record: string } {
    const root = mkdtempSync(join(tmpdir(), "page-fresh-"));
    roots.push(root);
    const dist = join(root, "web-v3", "dist");
    mkdirSync(dist, { recursive: true });
    const src = join(root, "src", "a.ts");
    mkdirSync(join(root, "src"));
    writeFileSync(src, "export {};\n");
    const record = `${dist}.inputs.json`;
    writeFileSync(record, JSON.stringify(sources === undefined ? { build: "x", inputs: [] } : { build: "x", inputs: [], sources: sources.length ? sources : [src] }));
    const t = Date.now() / 1000;
    utimesSync(src, t - 100, t - 100);
    utimesSync(record, t - 50, t - 50);
    return { dist, src, record };
  }

  it("passes a dist built after its sources", () => {
    const { dist } = layout([]);
    expect(pageStaleness(dist)).toBeNull();
    expect(() => assertPageFresh(dist)).not.toThrow();
  });

  it("refuses a dist older than a source, naming the file and the rebuild command", () => {
    const { dist, src } = layout([]);
    const t = Date.now() / 1000;
    utimesSync(src, t, t);
    expect(pageStaleness(dist)).toMatch(/^src\/a\.ts changed \d+ s after the build$/);
    expect(() => assertPageFresh(dist)).toThrow(REBUILD);
  });

  it("refuses a removed source, a record without sources and a missing record", () => {
    const gone = layout([]);
    rmSync(gone.src);
    expect(pageStaleness(gone.dist)).toMatch(/is gone$/);
    expect(pageStaleness(layout().dist)).toMatch(/no source list/);
    const missing = layout([]);
    rmSync(missing.record);
    expect(pageStaleness(missing.dist)).toMatch(/is missing$/);
  });

  it("leaves a missing dist to the tests' skip", () => {
    expect(() => assertPageFresh(join(tmpdir(), "no-such-page-dist", "dist"))).not.toThrow();
  });
});
