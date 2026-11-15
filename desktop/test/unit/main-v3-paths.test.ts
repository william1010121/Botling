// Botling 3 window data folder resolution (src/main-v3/paths.ts and src/main-v3/guard.ts): packaged Botling 3
// opens <appData>/Botling 3 and refuses 2.x's packaged and developer data folders; developer runs keep <desktop>/.data-v3.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packagedDataDir } from "../../src/main/main-environment";
import { applyV3Guard, v3DataDir } from "../../src/main-v3/paths";

const EXACT_2X_REFUSAL = "Botling 3 will not open the Botling 2 data folder; set BOTLING_DATA_DIR to another folder.";

describe("v3DataDir", () => {
  const root = "/repo/desktop";
  const appData = "/mock/app-data";

  it("packaged with no BOTLING_DATA_DIR uses <appData>/Botling 3", () => {
    expect(v3DataDir(root, {}, { appData })).toEqual({
      ok: true,
      dataDir: join(appData, "Botling 3"),
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: "" }, { appData })).toEqual({
      ok: true,
      dataDir: join(appData, "Botling 3"),
    });
  });

  it("packaged refuses 2.x packaged folders (normal and dev-trial) with the exact text", () => {
    const prod2x = packagedDataDir(appData, false);
    const trial2x = packagedDataDir(appData, true);

    expect(v3DataDir(root, { BOTLING_DATA_DIR: prod2x }, { appData })).toEqual({
      ok: false,
      error: EXACT_2X_REFUSAL,
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: trial2x }, { appData })).toEqual({
      ok: false,
      error: EXACT_2X_REFUSAL,
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(prod2x, "nested") }, { appData })).toEqual({
      ok: false,
      error: EXACT_2X_REFUSAL,
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(root, ".data") }, { appData })).toEqual({
      ok: false,
      error: EXACT_2X_REFUSAL,
    });
  });

  it("packaged allows an explicit non-2.x BOTLING_DATA_DIR", () => {
    expect(v3DataDir(root, { BOTLING_DATA_DIR: "/tmp/botling3-custom" }, { appData })).toEqual({
      ok: true,
      dataDir: "/tmp/botling3-custom",
    });
  });

  it("unpackaged keeps developer <desktop>/.data-v3 and refuses <desktop>/.data", () => {
    expect(v3DataDir(root, {})).toEqual({
      ok: true,
      dataDir: join(root, ".data-v3"),
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: "/tmp/dev-v3" })).toEqual({
      ok: true,
      dataDir: "/tmp/dev-v3",
    });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(root, ".data") })).toEqual({
      ok: false,
      error: EXACT_2X_REFUSAL,
    });
  });
});

describe("v3DataDir on disk (another spelling of the same folder)", () => {
  let base = "";
  afterEach(() => { if (base) rmSync(base, { recursive: true, force: true }); base = ""; });
  const refused = { ok: false, error: EXACT_2X_REFUSAL };

  it("refuses a symlink to 2.x's folder, a folder below one, and a default <appData>/Botling 3 that is a symlink", () => {
    base = mkdtempSync(join(tmpdir(), "v3-paths-"));
    const appData = join(base, "app-data");
    const root = join(base, "desktop");
    mkdirSync(join(appData, "Botling 2", "core"), { recursive: true });
    mkdirSync(join(root, ".data"), { recursive: true });
    symlinkSync(join(appData, "Botling 2"), join(base, "link-2x"));
    symlinkSync(join(root, ".data"), join(base, "link-dev"));
    symlinkSync(join(appData, "Botling 2", "core"), join(base, "link-2x-core"));
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "link-2x") }, { appData })).toEqual(refused);
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "link-2x", "core") }, { appData })).toEqual(refused);
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "link-2x", "new", "deeper") }, { appData })).toEqual(refused);
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "link-dev") })).toEqual(refused);
    // The link names a folder inside 2.x's: only its real path shows whose folder it is.
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "link-2x-core", "sub") }, { appData })).toEqual(refused);
    symlinkSync(join(appData, "Botling 2"), join(appData, "Botling 3"));
    expect(v3DataDir(root, {}, { appData })).toEqual(refused);
    mkdirSync(join(base, "own"));
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(base, "own") }, { appData })).toEqual({ ok: true, dataDir: join(base, "own") });
    expect(v3DataDir(root, { BOTLING_DATA_DIR: join(appData, "Botling 2x") }, { appData })).toEqual({ ok: true, dataDir: join(appData, "Botling 2x") });
  });

  it.runIf(process.platform === "darwin" || process.platform === "win32")("refuses another letter case of 2.x's folder (case-insensitive folders)", () => {
    const appData = "/mock/app-data";
    expect(v3DataDir("/repo/desktop", { BOTLING_DATA_DIR: join(appData, "botling 2") }, { appData })).toEqual(refused);
    expect(v3DataDir("/repo/desktop", { BOTLING_DATA_DIR: join(appData, "BOTLING 2 DEV TRIAL", "core") }, { appData })).toEqual(refused);
    expect(v3DataDir("/repo/desktop", { BOTLING_DATA_DIR: "/repo/desktop/.DATA" })).toEqual(refused);
  });
});

describe("applyV3Guard & main-v3/guard", () => {
  const savedDataDir = process.env.BOTLING_DATA_DIR;
  const savedChannel = process.env.BOTLING_UPDATE_CHANNEL;

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("electron");
    delete (globalThis as { __botlingV3Window?: boolean }).__botlingV3Window;
    if (savedDataDir === undefined) delete process.env.BOTLING_DATA_DIR;
    else process.env.BOTLING_DATA_DIR = savedDataDir;
    if (savedChannel === undefined) delete process.env.BOTLING_UPDATE_CHANNEL;
    else process.env.BOTLING_UPDATE_CHANNEL = savedChannel;
  });

  it("sets BOTLING_DATA_DIR and BOTLING_UPDATE_CHANNEL='v3' and throws on 2.x folders", () => {
    const appData = "/mock/app-data";
    const env: Record<string, string | undefined> = {};
    expect(applyV3Guard({ root: "/repo/desktop", env, packaged: { appData } })).toBe(join(appData, "Botling 3"));
    expect(env.BOTLING_DATA_DIR).toBe(join(appData, "Botling 3"));
    expect(env.BOTLING_UPDATE_CHANNEL).toBe("v3");

    expect(() =>
      applyV3Guard({
        root: "/repo/desktop",
        env: { BOTLING_DATA_DIR: packagedDataDir(appData, false) },
        packaged: { appData },
      }),
    ).toThrow(EXACT_2X_REFUSAL);
  });

  it("guard.ts configures packaged appData and channel 'v3' without throwing", async () => {
    const appData = "/tmp/fake-app-data";
    delete process.env.BOTLING_DATA_DIR;
    delete process.env.BOTLING_UPDATE_CHANNEL;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: { isPackaged: true, getPath: (name: string) => (name === "appData" ? appData : "/tmp/other") },
    }));
    await import("../../src/main-v3/guard");
    expect(process.env.BOTLING_DATA_DIR).toBe(join(resolve(appData), "Botling 3"));
    expect(process.env.BOTLING_UPDATE_CHANNEL).toBe("v3");
    expect((globalThis as { __botlingV3Window?: boolean }).__botlingV3Window).toBe(true);
  });
});
