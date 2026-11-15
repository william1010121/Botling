import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "../..");
const v2ConfigPath = join(desktopRoot, "electron-builder.config.cjs");
const v3ConfigPath = join(desktopRoot, "electron-builder.v3.config.cjs");
const packageScriptPath = join(desktopRoot, "scripts/package.mjs");

const req = createRequire(import.meta.url);
const savedEnv = {
  BOTLING_DIST_DIR: process.env.BOTLING_DIST_DIR,
  BOTLING_V3_VERSION: process.env.BOTLING_V3_VERSION,
};

function loadFreshConfig(configPath: string): Record<string, any> {
  delete req.cache[v2ConfigPath];
  delete req.cache[v3ConfigPath];
  return req(configPath);
}

function normalizeForDiffCheck(config: Record<string, any>): Record<string, any> {
  const clone = structuredClone(config);
  delete clone.appId;
  delete clone.productName;
  if (clone.extraMetadata) {
    delete clone.extraMetadata.main;
    delete clone.extraMetadata.version;
  }
  if (clone.directories) {
    delete clone.directories.output;
  }
  if (Array.isArray(clone.publish)) {
    clone.publish = clone.publish.map((entry: Record<string, any>) => {
      const copy = { ...entry };
      delete copy.channel;
      return copy;
    });
  } else if (clone.publish && typeof clone.publish === "object") {
    delete clone.publish.channel;
  }
  return clone;
}

afterEach(() => {
  if (savedEnv.BOTLING_DIST_DIR === undefined) delete process.env.BOTLING_DIST_DIR;
  else process.env.BOTLING_DIST_DIR = savedEnv.BOTLING_DIST_DIR;
  if (savedEnv.BOTLING_V3_VERSION === undefined) delete process.env.BOTLING_V3_VERSION;
  else process.env.BOTLING_V3_VERSION = savedEnv.BOTLING_V3_VERSION;
  delete req.cache[v2ConfigPath];
  delete req.cache[v3ConfigPath];
});

describe("Botling 3 electron-builder config (M6-07a)", () => {
  it("differs from the 2.x config in exactly the six specified fields and keeps fuses untouched", () => {
    delete process.env.BOTLING_DIST_DIR;
    delete process.env.BOTLING_V3_VERSION;

    const v2 = loadFreshConfig(v2ConfigPath);
    const v3 = loadFreshConfig(v3ConfigPath);

    expect(v3.appId).not.toBe(v2.appId);
    expect(v3.productName).toBe("Botling 3");
    expect(v3.productName).not.toBe(v2.productName);
    expect(v3.extraMetadata.main).toBe("out/main-v3/main.cjs");
    expect(v3.extraMetadata.main).not.toBe(v2.extraMetadata.main);
    expect(v3.extraMetadata.version).toBe("3.0.0-beta.1");
    expect(v2.extraMetadata.version).toBeUndefined();
    expect(v3.directories.output).not.toBe(v2.directories.output);

    expect(Array.isArray(v3.publish)).toBe(true);
    expect(v3.publish.length).toBeGreaterThan(0);
    for (const entry of v3.publish) {
      expect(entry.channel).toBe("v3");
    }
    for (const entry of v2.publish) {
      expect(entry.channel).toBeUndefined();
    }

    expect(v3.electronFuses).toEqual(v2.electronFuses);
    expect(v3.electronFuses.runAsNode).toBe(false);

    expect(normalizeForDiffCheck(v3)).toEqual(normalizeForDiffCheck(v2));
  });

  it("derives the v3 appId from the 2.x id prefix ending in .Botling3", () => {
    const v2 = loadFreshConfig(v2ConfigPath);
    const v3 = loadFreshConfig(v3ConfigPath);

    const lastDot = v2.appId.lastIndexOf(".");
    expect(lastDot).toBeGreaterThan(0);
    const prefix = v2.appId.slice(0, lastDot);
    expect(v3.appId.endsWith(".Botling3")).toBe(true);
    expect(v3.appId.startsWith(`${prefix}.`)).toBe(true);
    expect(v3.appId).toBe(`${prefix}.Botling3`);
  });

  it("points extraMetadata.main at the file build.mjs writes for main-v3", () => {
    const v3 = loadFreshConfig(v3ConfigPath);
    const buildMjs = readFileSync(join(desktopRoot, "build.mjs"), "utf8");

    expect(v3.extraMetadata.main).toBe("out/main-v3/main.cjs");
    expect(buildMjs).toContain("buildMainV3");
    expect(buildMjs).toContain(v3.extraMetadata.main);
  });

  it("writes v3 output to a separate subfolder and respects BOTLING_DIST_DIR and BOTLING_V3_VERSION", () => {
    delete process.env.BOTLING_DIST_DIR;
    delete process.env.BOTLING_V3_VERSION;
    const v2Default = loadFreshConfig(v2ConfigPath);
    const v3Default = loadFreshConfig(v3ConfigPath);

    expect(v3Default.directories.output).not.toBe(v2Default.directories.output);
    expect(v3Default.directories.output).toBe(join(desktopRoot, "dist", "v3"));

    process.env.BOTLING_DIST_DIR = "/tmp/botling-test-dist";
    process.env.BOTLING_V3_VERSION = "3.0.0-beta.9";
    const v2Custom = loadFreshConfig(v2ConfigPath);
    const v3Custom = loadFreshConfig(v3ConfigPath);

    expect(v3Custom.directories.output).not.toBe(v2Custom.directories.output);
    expect(v3Custom.directories.output).toBe(join("/tmp/botling-test-dist", "v3"));
    expect(v3Custom.extraMetadata.version).toBe("3.0.0-beta.9");
  });

  it("selects electron-builder.v3.config.cjs when package.mjs receives --v3", async () => {
    const pkgMod = await import(pathToFileURL(packageScriptPath).href);
    expect(typeof pkgMod.resolveBuilderConfigPath).toBe("function");

    expect(pkgMod.resolveBuilderConfigPath([], desktopRoot)).toBe(v2ConfigPath);
    expect(pkgMod.resolveBuilderConfigPath(["--mac", "--dir"], desktopRoot)).toBe(v2ConfigPath);
    expect(pkgMod.resolveBuilderConfigPath(["--v3"], desktopRoot)).toBe(v3ConfigPath);
    expect(pkgMod.resolveBuilderConfigPath(["--mac", "--dir", "--v3"], desktopRoot)).toBe(v3ConfigPath);
  });
});
