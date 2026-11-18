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
  delete clone.dmg?.contents; // v3 always holds the Applications link; the 2.x trial layout depends on package.json
  if (clone.extraMetadata) delete clone.extraMetadata.botlingDevTrial;
  delete clone.productName;
  delete clone.artifactName;
  if (clone.extraMetadata) {
    delete clone.extraMetadata.main;
    delete clone.extraMetadata.version;
    delete clone.extraMetadata.appId;
  }
  if (clone.directories) {
    delete clone.directories.output;
  }
  if (clone.nsis) {
    delete clone.nsis.artifactName;
  }
  if (clone.linux) {
    delete clone.linux.executableName;
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

describe("Botling 3 electron-builder config (M6-07a / M6-07c)", () => {
  it("differs from the 2.x config only in the v3 overrides and keeps fuses untouched", () => {
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
    expect(v3.extraMetadata.appId).toBe(v3.appId);
    expect(v2.extraMetadata.appId).toBeUndefined();
    expect(v3.directories.output).not.toBe(v2.directories.output);

    expect(v3.artifactName).toBe("Botling-3-${version}-${os}-${arch}.${ext}");
    expect(v3.artifactName).not.toBe(v2.artifactName);
    expect(v3.nsis.artifactName).toBe("Botling-3-${version}-win-${arch}.${ext}");
    expect(v3.nsis.artifactName).not.toBe(v2.nsis.artifactName);
    expect(v3.linux.executableName).toBe("botling3");
    expect(v3.linux.executableName).not.toBe(v2.linux.executableName);

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

  it("is never a dev trial: the packed package.json says false and the DMG holds the Applications link, whatever package.json says", () => {
    const v2 = loadFreshConfig(v2ConfigPath);
    const v3 = loadFreshConfig(v3ConfigPath);
    expect(v3.extraMetadata.botlingDevTrial).toBe(false);
    expect(v2.extraMetadata.botlingDevTrial).toBeUndefined();
    const paths = v3.dmg.contents.map((item: Record<string, any>) => item.path ?? null);
    expect(v3.dmg.contents).toContainEqual({ x: 450, y: 180, type: "link", path: "/Applications" });
    for (const name of ["DEV-TRIAL.md", "Launch Dev Trial.command"]) expect(v3.dmg.contents.map((item: Record<string, any>) => item.name)).not.toContain(name);
    expect(paths.some((path: string | null) => path?.includes("dev-trial"))).toBe(false);
    expect(v3.dmg.sign).toBe(v2.dmg.sign);
    expect(v3.dmg.writeUpdateInfo).toBe(false);
  });

  it("has a dist:mac:v3 script that packages the v3 config for macOS", () => {
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
    expect(pkg.scripts["dist:mac:v3"]).toBe("node scripts/package.mjs --v3 --mac");
  });

  it("a Botling 3 release build must be told package.json's version (BOTLING_V3_VERSION); other builds are not judged", async () => {
    const { assertV3ReleaseVersion } = await import(pathToFileURL(packageScriptPath).href);
    const release = { BOTLING_RELEASE_BUILD: "1" };
    expect(() => assertV3ReleaseVersion(["--v3", "--mac"], release, "3.2.2")).toThrow(/BOTLING_V3_VERSION=3\.2\.2.*got nothing/);
    expect(() => assertV3ReleaseVersion(["--v3", "--mac"], { ...release, BOTLING_V3_VERSION: "3.0.0-beta.1" }, "3.2.2")).toThrow(/got 3\.0\.0-beta\.1/);
    expect(() => assertV3ReleaseVersion(["--v3", "--mac"], { ...release, BOTLING_V3_VERSION: "3.2.1" }, "3.2.2")).toThrow(/BOTLING_V3_VERSION/);
    expect(() => assertV3ReleaseVersion(["--v3", "--mac"], { ...release, BOTLING_V3_VERSION: "2.6.0" }, "2.6.0")).toThrow(/stable 3\.x\.y/);
    expect(() => assertV3ReleaseVersion(["--v3", "--mac"], { ...release, BOTLING_V3_VERSION: "3.2.2" }, "3.2.2")).not.toThrow();
    // A developer's local build, and a 2.x build, keep working without it.
    expect(() => assertV3ReleaseVersion(["--v3", "--dir"], {}, "3.2.2")).not.toThrow();
    expect(() => assertV3ReleaseVersion(["--mac"], release, "3.2.2")).not.toThrow();
  });
});
