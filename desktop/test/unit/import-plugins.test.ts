import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { folderHash } from "../../src/core/plugins/catalog";
import { importPlugins } from "../../src/server/import/plugins";
import { make2xFolder } from "../support/fixture-2x";

interface FileSnapshot {
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

function collectFiles(root: string, dir = root, out: FileSnapshot[] = []): FileSnapshot[] {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, full, out);
    } else if (entry.isFile()) {
      const stat = statSync(full);
      const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
      out.push({ rel: relative(root, full), size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    }
  }
  return out;
}

function setModeRecursive(dir: string, dirMode: number, fileMode: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      setModeRecursive(full, dirMode, fileMode);
      chmodSync(full, dirMode);
    } else {
      chmodSync(full, fileMode);
    }
  }
  chmodSync(dir, dirMode);
}

describe("2.x plugin library and data import", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "botling-import-plugins-"));
  });

  afterEach(() => {
    try {
      setModeRecursive(root, 0o755, 0o644);
    } catch {
      // ignore if already removed
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("copies plugins (text and binary), plugin-data, and preserves folderHash and non-secret plugins.json state", () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const fx = make2xFolder(src);

    // Add bundled binary assets + claude metadata to the sample plugin
    const pluginDir = join(src, "plugins", fx.pluginName);
    const binaryAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    mkdirSync(join(pluginDir, "assets"), { recursive: true });
    writeFileSync(join(pluginDir, "assets", "icon.png"), binaryAsset);
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: fx.pluginName }));

    // Add rich plugins.json with disabled, failures, installed, keys, and settings
    writeFileSync(
      join(src, "plugins.json"),
      JSON.stringify({
        disabled: ["other-plugin"],
        failures: { [fx.pluginName]: { message: "crashed in 2.x", fingerprint: "abc" } },
        installed: { [fx.pluginName]: "local" },
        keys: { [fx.pluginName]: { "sample.cmd": "cmd+shift+k" } },
        settings: { [fx.pluginName]: { greeting: "hello" } },
      }),
    );

    const result = importPlugins(src, dst);

    expect(result.problems).toEqual([]);
    expect(result.hashMismatches).toEqual([]);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]).toMatchObject({
      name: fx.pluginName,
      version: "1.0.0",
      hashMatches: true,
    });
    expect(result.plugins[0]!.targetHash).toBe(folderHash(pluginDir));
    expect(folderHash(join(dst, "plugins", fx.pluginName))).toBe(folderHash(pluginDir));

    expect(readFileSync(join(dst, "plugins", fx.pluginName, "web.js"), "utf8")).toBe("export function activate() {}\n");
    expect(readFileSync(join(dst, "plugins", fx.pluginName, "assets", "icon.png"))).toEqual(binaryAsset);
    expect(existsSync(join(dst, "plugins", fx.pluginName, ".claude-plugin", "plugin.json"))).toBe(true);

    expect(result.dataDirsCopied).toContain(fx.pluginName);
    expect(JSON.parse(readFileSync(join(dst, "plugin-data", fx.pluginName, "state.json"), "utf8"))).toEqual({ count: 1 });

    expect(result.pluginsJsonWritten).toBe(true);
    const migratedState = JSON.parse(readFileSync(join(dst, "plugins.json"), "utf8")) as Record<string, unknown>;
    expect(migratedState).toEqual({
      disabled: ["other-plugin"],
      settings: { [fx.pluginName]: { greeting: "hello" } },
      failures: {},
      installed: { [fx.pluginName]: "local" },
      keys: { [fx.pluginName]: { "sample.cmd": "cmd+shift+k" } },
    });
  });

  it("strips secret settings from plugins.json and never writes secret plaintext anywhere in target", () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const leakedSecretInPluginsJson = "leaked-fixture-token-999";
    const fx = make2xFolder(src, { pluginSecretPlaintext: "sealed-fixture-secret-123" });

    // Also create a second plugin using the v3 `botling` manifest field with a secret setting
    const v3StylePlugin = join(src, "plugins", "botling-style-plugin");
    mkdirSync(v3StylePlugin, { recursive: true });
    writeFileSync(
      join(v3StylePlugin, "package.json"),
      JSON.stringify({
        name: "botling-style-plugin",
        version: "1.0.0",
        botling: {
          contributes: {
            settings: {
              endpoint: { type: "string", title: "Endpoint" },
              webhookSecret: { type: "string", title: "Webhook Secret", secret: true },
            },
          },
        },
      }),
    );

    writeFileSync(
      join(src, "plugins.json"),
      JSON.stringify({
        disabled: [],
        failures: {},
        installed: {},
        settings: {
          [fx.pluginName]: {
            greeting: "hi",
            [fx.secretKey]: leakedSecretInPluginsJson,
          },
          "botling-style-plugin": {
            endpoint: "https://127.0.0.1:9000",
            webhookSecret: leakedSecretInPluginsJson,
          },
        },
      }),
    );

    const result = importPlugins(src, dst);

    const migratedState = JSON.parse(readFileSync(join(dst, "plugins.json"), "utf8")) as {
      settings: Record<string, Record<string, unknown>>;
    };
    expect(migratedState.settings[fx.pluginName]).toEqual({ greeting: "hi" });
    expect(migratedState.settings[fx.pluginName]).not.toHaveProperty(fx.secretKey);
    expect(migratedState.settings["botling-style-plugin"]).toEqual({ endpoint: "https://127.0.0.1:9000" });
    expect(migratedState.settings["botling-style-plugin"]).not.toHaveProperty("webhookSecret");

    expect(result.secretsStripped).toEqual([
      { plugin: fx.pluginName, keys: [fx.secretKey] },
      { plugin: "botling-style-plugin", keys: ["webhookSecret"] },
    ]);

    // Verify neither the sealed secret plaintext nor the leaked secret appears in any copied file
    for (const snap of collectFiles(dst)) {
      const content = readFileSync(join(dst, snap.rel), "utf8");
      expect(content).not.toContain(fx.secretPlaintext);
      expect(content).not.toContain(leakedSecretInPluginsJson);
    }
  });

  it("never copies node_modules/, .git/, or files exceeding the size limit, and lists mismatches", () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const fx = make2xFolder(src);
    const pluginDir = join(src, "plugins", fx.pluginName);

    mkdirSync(join(pluginDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(pluginDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(pluginDir, ".git", "objects"), { recursive: true });
    writeFileSync(join(pluginDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(pluginDir, "large.bin"), Buffer.alloc(2048, 0xab));

    const result = importPlugins(src, dst, { maxFileBytes: 1024 });

    expect(existsSync(join(dst, "plugins", fx.pluginName, "node_modules"))).toBe(false);
    expect(existsSync(join(dst, "plugins", fx.pluginName, ".git"))).toBe(false);
    expect(existsSync(join(dst, "plugins", fx.pluginName, "large.bin"))).toBe(false);
    expect(existsSync(join(dst, "plugins", fx.pluginName, "web.js"))).toBe(true);

    expect(result.skipped.some((s) => s.includes("node_modules"))).toBe(true);
    expect(result.skipped.some((s) => s.includes(".git"))).toBe(true);
    expect(result.skipped.some((s) => s.includes("large.bin"))).toBe(true);
    expect(result.hashMismatches).toHaveLength(1);
    expect(result.hashMismatches[0]!.name).toBe(fx.pluginName);
  });

  it("never copies plugin-secrets.json", () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    make2xFolder(src);

    expect(existsSync(join(src, "plugin-secrets.json"))).toBe(true);
    importPlugins(src, dst);
    expect(existsSync(join(dst, "plugin-secrets.json"))).toBe(false);
  });

  it("skips older library copies of built-in plugins, copies same/newer copies, and keeps built-in plugin-data", () => {
    const src = join(root, "v2");
    const dst = join(root, "v3");
    const builtIns = join(root, "builtins");
    make2xFolder(src);

    // Built-in plugins shipped with botlingd
    mkdirSync(join(builtIns, "botling.note"), { recursive: true });
    writeFileSync(join(builtIns, "botling.note", "package.json"), JSON.stringify({ name: "botling.note", version: "2.0.0" }));
    mkdirSync(join(builtIns, "botling.board"), { recursive: true });
    writeFileSync(join(builtIns, "botling.board", "package.json"), JSON.stringify({ name: "botling.board", version: "1.5.0" }));

    // Older library copy of botling.note (should NOT be copied)
    mkdirSync(join(src, "plugins", "botling.note"), { recursive: true });
    writeFileSync(join(src, "plugins", "botling.note", "package.json"), JSON.stringify({ name: "botling.note", version: "1.2.0" }));

    // Newer library copy of botling.board (SHOULD be copied)
    mkdirSync(join(src, "plugins", "botling.board"), { recursive: true });
    writeFileSync(join(src, "plugins", "botling.board", "package.json"), JSON.stringify({ name: "botling.board", version: "1.6.0" }));

    // Data folder for built-in plugin botling.note
    mkdirSync(join(src, "plugin-data", "botling.note"), { recursive: true });
    writeFileSync(join(src, "plugin-data", "botling.note", "notes.json"), JSON.stringify([{ title: "keep me" }]));

    const result = importPlugins(src, dst, { builtInsDir: builtIns });

    expect(existsSync(join(dst, "plugins", "botling.note"))).toBe(false);
    expect(existsSync(join(dst, "plugins", "botling.board", "package.json"))).toBe(true);
    expect(result.plugins.find((p) => p.name === "botling.board")?.replacesBuiltIn).toBe(true);
    expect(result.skipped.some((s) => s.includes("botling.note"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dst, "plugin-data", "botling.note", "notes.json"), "utf8"))).toEqual([{ title: "keep me" }]);
  });

  it("leaves the source folder completely untouched even when read-only", () => {
    const src = join(root, "readonly-v2");
    const dst = join(root, "v3");
    make2xFolder(src);
    const before = collectFiles(src);

    setModeRecursive(src, 0o555, 0o444);
    try {
      const result = importPlugins(src, dst);
      expect(result.problems).toEqual([]);
    } finally {
      setModeRecursive(src, 0o755, 0o644);
    }

    expect(collectFiles(src)).toEqual(before);
  });

  it("reports malformed plugins.json in problems while still copying plugins and plugin-data", () => {
    const src = join(root, "broken-plugins-json");
    const dst = join(root, "v3");
    const fx = make2xFolder(src, { brokenFiles: ["plugins.json"] });

    const result = importPlugins(src, dst);

    expect(result.problems.some((p) => p.includes("plugins.json"))).toBe(true);
    expect(result.pluginsJsonWritten).toBe(false);
    expect(existsSync(join(dst, "plugins", fx.pluginName, "package.json"))).toBe(true);
    expect(existsSync(join(dst, "plugin-data", fx.pluginName, "state.json"))).toBe(true);
  });
});
