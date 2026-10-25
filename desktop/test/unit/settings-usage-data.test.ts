import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UsageView } from "../../src/contract";
import { UsageBook, usageView } from "../../src/core/usage";
import { importFrom1x } from "../../src/core/store/importer";
import { writeSwiftFixture } from "../fixtures/swift-data";
import { tempDir } from "../helpers";

const now = new Date(2026, 9, 26, 12);
const spending = { day: "2026-10-25", spent: 1.25, byBot: { Shop: 1.25 }, tokens: { input: 100, output: 200, cacheWrite: 300, cacheRead: 400 }, tokensByBot: {}, history: [] };

describe("Settings usage data", () => {
  it("imports only the three usage records and retains original bytes/mtime; yesterday rolls into history once", () => {
    const { source } = writeSwiftFixture(tempDir("settings-usage-import"));
    const files = { "spending.json": spending, "rate-limits.json": { fiveHour: { used: 0.42, seen: 800000000 } }, "codex-rate-limits.json": { week: { used: 0.31, seen: 800000000 } } };
    const before = Object.entries(files).map(([name, value]) => {
      const path = join(source, name); writeFileSync(path, JSON.stringify(value));
      return { name, bytes: readFileSync(path), mtime: statSync(path).mtimeMs };
    });
    const target = tempDir("settings-usage-imported");
    importFrom1x(source, target);
    for (const { name, bytes, mtime } of before) {
      expect(readFileSync(join(target, name))).toEqual(bytes);
      expect(readFileSync(join(source, name))).toEqual(bytes);
      expect(statSync(join(source, name)).mtimeMs).toBe(mtime);
    }
    const book = new UsageBook(target, undefined, now);
    for (let i = 0; i < 2; i++) {
      const view = UsageView.parse(usageView(book.view(now)));
      expect(view).toMatchObject({ spendingStatus: "available", day: "2026-10-26", spent: 0, byBot: [], history: [{ day: "2026-10-25", spent: 1.25, tokens: 1000 }], claude: { fiveHour: { used: 0.42 } }, codex: { week: { used: 0.31 } } });
    }
  });

  it("skips malformed usage records without failing chat import and never copies unrelated fields", () => {
    const { source } = writeSwiftFixture(tempDir("settings-usage-malformed"));
    writeFileSync(join(source, "spending.json"), "{broken");
    writeFileSync(join(source, "rate-limits.json"), JSON.stringify({ fiveHour: { used: .42, seen: 800000000 }, unrelatedPrivateField: "synthetic-only" }));
    writeFileSync(join(source, "codex-rate-limits.json"), JSON.stringify([1, 2]));
    const target = tempDir("settings-usage-checked");
    const report = importFrom1x(source, target);
    expect(report.messages).toBeGreaterThan(0);
    expect(report.skipped.filter(line => line.includes("not a valid usage record"))).toHaveLength(2);
    expect(existsSync(join(target, "spending.json"))).toBe(false);
    expect(existsSync(join(target, "codex-rate-limits.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(target, "rate-limits.json"), "utf8"))).toEqual({ fiveHour: { used: .42, seen: 800000000 } });
  });

  it("keeps cost-only and token-only bots, sorts by cost then tokens, and counts cache categories exactly once", () => {
    const dir = tempDir("settings-usage-totals");
    const book = new UsageBook(dir, undefined, now);
    book.record(2, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, "Cost only", now);
    book.record(0, { input: 100, output: 200, cacheWrite: 300, cacheRead: 400 }, "Tokens only", now);
    const view = usageView(book.view(now));
    expect(view.byBot).toEqual([{ name: "Cost only", spent: 2, tokens: 0 }, { name: "Tokens only", spent: 0, tokens: 1000 }]);
    expect(view.spent).toBe(2);
    const tomorrow = new Date(2026, 9, 27, 0, 1);
    for (let i = 0; i < 2; i++) expect(usageView(book.view(tomorrow))).toMatchObject({ day: "2026-10-27", spent: 0, byBot: [], history: [{ day: "2026-10-26", spent: 2, tokens: 1000 }] });
  });

  it.each(["missing", "unreadable"] as const)("distinguishes %s spending from measured zero; a recorded turn makes usage available", status => {
    const dir = tempDir("settings-usage-state");
    if (status === "unreadable") writeFileSync(join(dir, "spending.json"), "{broken");
    const book = new UsageBook(dir, undefined, now);
    expect(usageView(book.view(now))).toMatchObject({ spendingStatus: status });
    book.record(0, { input: 0, output: 20, cacheWrite: 0, cacheRead: 0 }, "Codex", now);
    expect(usageView(book.view(now))).toMatchObject({ spendingStatus: "available", spent: 0, tokens: { output: 20 }, byBot: [{ name: "Codex", spent: 0, tokens: 20 }] });
  });
});
