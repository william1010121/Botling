// M5-13a: `plugin:<name>` row schema in `srv:` tables (D52, §8.2, Q-C9).
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/protocol/entries";
import { decodeWireFrame, encodeWireFrame } from "../../src/protocol/frame";
import {
  knownRowKey, PluginGrant, PluginRow, rowBodySchema, Rows, TABLE_ROW_CHARS, TableRow, Tier, UnknownRowBody,
} from "../../src/protocol/table-rows";

function sampleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const hash = "a".repeat(64);
  return {
    codeHash: hash,
    manifest: {
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send", "plugins.call"],
      owns: ["note"],
      provides: ["panel"],
      requires: ["storage"],
      uses: ["theme"],
      clients: ["web"],
      needsShell: ["link"],
    },
    author: "user",
    grants: {
      [hash]: {
        tier: "request",
        reads: ["chat.snapshot"],
        requests: ["chat.send"],
        grantedBy: "user",
        at: 1_700_000_000_000,
      },
    },
    ...over,
  };
}

describe("M5-13a: plugin:<name> row schema", () => {
  it("parses a full plugin row and refuses extra keys", () => {
    const row = sampleRow();
    expect(Tier.safeParse("read").success).toBe(true);
    expect(Tier.safeParse("request").success).toBe(true);
    expect(Tier.safeParse("write").success).toBe(true);
    expect(PluginGrant.safeParse((row.grants as Record<string, unknown>)["a".repeat(64)]).success).toBe(true);
    expect(PluginRow.safeParse(row).success).toBe(true);

    expect(knownRowKey("plugin:botling.notes")).toBe(true);
    expect(rowBodySchema("plugin:botling.notes")).toBe(PluginRow);
    expect(TableRow.safeParse({ key: "plugin:botling.notes", rev: 1, body: row }).success).toBe(true);

    // Optional `files` is allowed when absent or present, but never required.
    expect(PluginRow.safeParse(sampleRow({ files: [{ path: "index.js" }] })).success).toBe(true);

    // Extra keys at row, manifest, or grant level are refused.
    expect(PluginRow.safeParse(sampleRow({ extra: true })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      manifest: { ...(row.manifest as Record<string, unknown>), extra: 1 },
    })).success).toBe(false);
    const grant = (row.grants as Record<string, Record<string, unknown>>)["a".repeat(64)];
    expect(PluginRow.safeParse(sampleRow({
      grants: { ["a".repeat(64)]: { ...grant, extra: 1 } },
    })).success).toBe(false);

    // Row key limits: <= 64 chars after `plugin:` passes; empty or > 64 chars fails (Q-C9).
    expect(TableRow.safeParse({ key: `plugin:${"p".repeat(64)}`, rev: 1, body: row }).success).toBe(true);
    expect(TableRow.safeParse({ key: `plugin:${"p".repeat(65)}`, rev: 1, body: row }).success).toBe(false);
    expect(TableRow.safeParse({ key: "plugin:", rev: 1, body: row }).success).toBe(false);
  });

  it("refuses an invalid grant tier, more than 20 grants, bad codeHash, or unknown command types", () => {
    const base = sampleRow();
    const hash = "b".repeat(64);
    const baseGrant = (base.grants as Record<string, Record<string, unknown>>)["a".repeat(64)];

    // Invalid tier in grant or manifest.
    expect(PluginRow.safeParse(sampleRow({
      grants: { [hash]: { ...baseGrant, tier: "admin" } },
    })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      manifest: { ...(base.manifest as Record<string, unknown>), tier: "owner" },
    })).success).toBe(false);

    // 20 grants allowed; 21 refused.
    const twenty: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) twenty[`h${i}`] = baseGrant;
    expect(PluginRow.safeParse(sampleRow({ grants: twenty })).success).toBe(true);
    const twentyOne = { ...twenty, h20: baseGrant };
    expect(PluginRow.safeParse(sampleRow({ grants: twentyOne })).success).toBe(false);

    // Typos / unknown command types in requests are refused in both manifest and grant.
    expect(PluginRow.safeParse(sampleRow({
      manifest: { ...(base.manifest as Record<string, unknown>), requests: ["chat.sned"] },
    })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      grants: { [hash]: { ...baseGrant, requests: ["not.a.command"] } },
    })).success).toBe(false);

    // Server-only commands (call-ins, M5-01) are never a plugin's request: refused in the manifest and in a grant.
    for (const type of ["callin.ask", "callin.reply", "callin.cancel"]) {
      expect(PluginRow.safeParse(sampleRow({
        manifest: { ...(base.manifest as Record<string, unknown>), requests: ["chat.send", type] },
      })).success, `manifest ${type}`).toBe(false);
      expect(PluginRow.safeParse(sampleRow({
        grants: { [hash]: { ...baseGrant, requests: [type] } },
      })).success, `grant ${type}`).toBe(false);
    }

    // Invalid codeHash (root or grant key) and negative/float `at` are refused.
    expect(PluginRow.safeParse(sampleRow({ codeHash: "bad hash!" })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({ grants: { "bad key!": baseGrant } })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({ grants: { [hash]: { ...baseGrant, at: -1 } } })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({ grants: { [hash]: { ...baseGrant, at: 1.5 } } })).success).toBe(false);

    // Array and item size limits.
    expect(PluginRow.safeParse(sampleRow({
      grants: { [hash]: { ...baseGrant, reads: Array.from({ length: 51 }, (_, i) => `r${i}`) } },
    })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      grants: { [hash]: { ...baseGrant, requests: Array.from({ length: 101 }, () => "chat.send") } },
    })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      manifest: { ...(base.manifest as Record<string, unknown>), owns: Array.from({ length: 101 }, (_, i) => `o${i}`) },
    })).success).toBe(false);
    expect(PluginRow.safeParse(sampleRow({
      manifest: { ...(base.manifest as Record<string, unknown>), uses: ["x".repeat(201)] },
    })).success).toBe(false);
  });

  it("is kept verbatim by an older reader that treats unknown kinds as UnknownRowBody (N4) and round-trips on the wire", () => {
    const body = sampleRow();
    // Pre-M5-13a readers returned null from rowBodySchema("plugin:...") and validated with UnknownRowBody.
    const unknownParsed = UnknownRowBody.safeParse(body);
    expect(unknownParsed.success).toBe(true);
    if (unknownParsed.success) expect(unknownParsed.data).toEqual(body);

    const frame: Rows = {
      t: "rows",
      stream: `srv:${"A".repeat(26)}`,
      logId: "log12345",
      after: 0,
      to: 1,
      rows: [{ key: "plugin:sample", rev: 1, body }],
      more: false,
    };
    const encoded = encodeWireFrame(frame, "peer", { local: false });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeWireFrame(new TextEncoder().encode(encoded.text), "peer", { local: false });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message).toEqual(frame);
  });

  it("refuses a plugin row over 32 KiB", () => {
    const bigItem = "x".repeat(200);
    const hundredItems = Array.from({ length: 100 }, () => bigItem);
    // Each field stays within its own item/array bound, while total canonical JSON exceeds TABLE_ROW_CHARS.
    const overSized = sampleRow({
      manifest: {
        tier: "write",
        reads: hundredItems,
        requests: Array.from({ length: 100 }, () => "chat.send"),
        owns: hundredItems,
        provides: hundredItems,
        requires: hundredItems,
        uses: hundredItems,
        clients: hundredItems,
        needsShell: hundredItems,
      },
    });
    expect(canonicalJson(overSized).length).toBeGreaterThan(TABLE_ROW_CHARS);
    expect(PluginRow.safeParse(overSized).success).toBe(false);
    expect(TableRow.safeParse({ key: "plugin:oversized", rev: 1, body: overSized }).success).toBe(false);
  });
});
