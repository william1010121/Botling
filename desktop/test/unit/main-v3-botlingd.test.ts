// Botling 3 M6-07c: packaged `--botlingd` launch path, pure launch builders, and no-window / no-lock / dock-hidden guarantees.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFeStorage } from "../../src/fe-link";
import { botlingdArgs, packagedAppId, runMainV3 } from "../../src/main-v3/main";
import { ServerClient, botlingdLaunchEnv, botlingdLaunchSpec, serverPaths } from "../../src/main-v3/server-client";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { FakeClock, flush } from "./fe-link-harness";

const desktopRoot = resolve(__dirname, "../..");
const req = createRequire(import.meta.url);
const v3Config = req(join(desktopRoot, "electron-builder.v3.config.cjs")) as { appId: string };

const tempRoots: string[] = [];
function tempDir(prefix: string): string {
  const dir = testRoot(prefix);
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

describe("M6-07c --botlingd argument and launch builders", () => {
  it("parses --botlingd arguments before handing off to botlingd CLI", () => {
    expect(botlingdArgs(["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "--botlingd", "start"])).toEqual(["start"]);
    expect(botlingdArgs(["electron", ".", "--botlingd", "service", "install"])).toEqual(["service", "install"]);
    expect(botlingdArgs(["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "--botlingd"])).toEqual([]);
    expect(botlingdArgs(["/Applications/Botling 3.app/Contents/MacOS/Botling 3"])).toBeNull();
  });

  it("builds packaged launch spec with --botlingd start and without ELECTRON_RUN_AS_NODE", () => {
    const paths = serverPaths({ BOTLING_APP_DATA_DIR: "/tmp/v3-app", BOTLING_SERVER_SOCKET: "/tmp/v3.sock" });
    const baseEnv = {
      PATH: "/usr/bin",
      BOTLING_IMPORT_FROM: "/tmp/2x",
      BOTLING_1X_DIR: "/tmp/1x",
      ELECTRON_RUN_AS_NODE: "1",
      BOTLING_SERVER_SOCKET: "/tmp/v3.sock",
    };

    const pkgEnv = botlingdLaunchEnv(baseEnv, paths, { packaged: true });
    expect(pkgEnv).toEqual({
      PATH: "/usr/bin",
      BOTLING_DATA_DIR: paths.serverDir,
      BOTLING_SERVER_SOCKET: "/tmp/v3.sock",
    });
    expect(pkgEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(pkgEnv.BOTLING_IMPORT_FROM).toBeUndefined();
    expect(pkgEnv.BOTLING_1X_DIR).toBeUndefined();

    const pkgSpec = botlingdLaunchSpec(baseEnv, paths, {
      packaged: true,
      execPath: "/Applications/Botling 3.app/Contents/MacOS/Botling 3",
      script: "/ignored/out/server/main.cjs",
    });
    expect(pkgSpec).toEqual({
      program: "/Applications/Botling 3.app/Contents/MacOS/Botling 3",
      args: ["--botlingd", "start"],
      env: pkgEnv,
    });

    const devSpec = botlingdLaunchSpec(baseEnv, paths, {
      packaged: false,
      execPath: "/opt/electron",
      script: "/repo/desktop/out/server/main.cjs",
    });
    expect(devSpec).toEqual({
      program: "/opt/electron",
      args: ["/repo/desktop/out/server/main.cjs", "start"],
      env: {
        PATH: "/usr/bin",
        ELECTRON_RUN_AS_NODE: "1",
        BOTLING_DATA_DIR: paths.serverDir,
        BOTLING_SERVER_SOCKET: "/tmp/v3.sock",
        BOTLING_PLUGIN_HOST: "node",
      },
    });
  });

  it("ServerClient spawns [process.execPath, '--botlingd', 'start'] without ELECTRON_RUN_AS_NODE when packaged", async () => {
    const dir = tempDir("srv-client-pkg");
    const spawnMock = vi.fn(() => ({ pid: 9999, unref: vi.fn() }));
    const client = new ServerClient(
      {
        script: "/app.asar/out/core/main.cjs",
        env: { BOTLING_APP_DATA_DIR: dir, BOTLING_SERVER_SOCKET: join(dir, "missing.sock"), ELECTRON_RUN_AS_NODE: "1" },
        onEvent: () => undefined,
        audit: () => undefined,
      },
      {
        storage: () => new MemoryFeStorage(),
        clock: new FakeClock(),
        readToken: () => "t".repeat(32),
        packaged: true,
        spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
      },
    );

    client.start();
    await client.ready();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await flush();
    await client.stop();

    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [string, string[], { env: Record<string, string>; detached: boolean; stdio: string }];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(["--botlingd", "start"]);
    expect(opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(opts.env.BOTLING_DATA_DIR).toBe(join(dir, "server"));
    expect(opts.detached).toBe(true);
  });
});

describe("M6-07c main-v3 --botlingd flag path", () => {
  it("has no top-level static imports of guard, 2.x main, or BrowserWindow", () => {
    const src = readFileSync(join(desktopRoot, "src/main-v3/main.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import\s+[^;]*["']\.\/guard["']/m);
    expect(src).not.toMatch(/^\s*import\s+[^;]*["']\.\.\/main\/main["']/m);
    expect(src).not.toContain("BrowserWindow");
  });

  it("hides Dock icon on macOS, takes no single-instance lock, loads no BrowserWindow, and forwards packaged appId", async () => {
    const appDir = tempDir("pkg-app");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "botling-desktop", appId: v3Config.appId }));
    expect(packagedAppId(appDir)).toBe(v3Config.appId);

    const hideDock = vi.fn();
    const setActivationPolicy = vi.fn();
    const requestSingleInstanceLock = vi.fn(() => {
      throw new Error("requestSingleInstanceLock must not be called on --botlingd");
    });
    const mockElectron: Record<string, unknown> = {
      app: {
        isPackaged: true,
        isReady: () => false,
        setActivationPolicy,
        dock: { hide: hideDock },
        requestSingleInstanceLock,
      },
    };
    Object.defineProperty(mockElectron, "BrowserWindow", {
      get() {
        throw new Error("BrowserWindow must not be loaded on --botlingd");
      },
    });

    const runServerCli = vi.fn(async () => undefined);
    const loadWindowMain = vi.fn(() => {
      throw new Error("window main must not be loaded on --botlingd");
    });
    const exit = vi.fn();
    const env: Record<string, string | undefined> = {
      BOTLING_SERVER_DATA_DIR: "/tmp/v3-srv",
      BOTLING_FAKE_CLI: "/tmp/fake.mjs",
      ELECTRON_RUN_AS_NODE: "1",
    };

    await runMainV3({
      argv: ["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "--botlingd", "start"],
      platform: "darwin",
      env,
      electron: mockElectron as any,
      root: appDir,
      outDir: "/app.asar/out",
      runServerCli,
      loadWindowMain,
      exit,
    });

    expect(setActivationPolicy).toHaveBeenCalledWith("prohibited");
    expect(hideDock).toHaveBeenCalledTimes(1);
    expect(requestSingleInstanceLock).not.toHaveBeenCalled();
    expect(loadWindowMain).not.toHaveBeenCalled();
    expect(env.BOTLING_FAKE_CLI).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(runServerCli).toHaveBeenCalledWith(["start"], {
      packaged: true,
      appId: v3Config.appId,
      outDir: "/app.asar/out",
    });
    expect(exit).not.toHaveBeenCalled();

    runServerCli.mockClear();
    await runMainV3({
      argv: ["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "--botlingd", "service", "install"],
      platform: "darwin",
      env: { BOTLING_SERVER_DATA_DIR: "/tmp/v3-srv" },
      electron: mockElectron as any,
      root: appDir,
      outDir: "/app.asar/out",
      runServerCli,
      loadWindowMain,
      exit,
    });
    expect(runServerCli).toHaveBeenCalledWith(["service", "install"], {
      packaged: true,
      appId: v3Config.appId,
      outDir: "/app.asar/out",
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("awaits app.whenReady() before starting packaged --botlingd and forwards electronUtility", async () => {
    const appDir = tempDir("pkg-ready");
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "botling-desktop", appId: v3Config.appId }));

    const order: string[] = [];
    let releaseReady!: () => void;
    const readyPromise = new Promise<void>((resolveReady) => {
      releaseReady = () => {
        order.push("whenReady.resolved");
        resolveReady();
      };
    });
    const utilityProcess = { fork: vi.fn() };
    const MessageChannelMain = vi.fn();
    const mockElectron: Record<string, unknown> = {
      app: {
        isPackaged: true,
        isReady: () => false,
        setActivationPolicy: () => { order.push("setActivationPolicy"); },
        dock: { hide: () => { order.push("dock.hide"); } },
        whenReady: () => {
          order.push("whenReady.called");
          return readyPromise;
        },
      },
      utilityProcess,
      MessageChannelMain,
    };

    const runServerCli = vi.fn(async () => { order.push("runServerCli"); });
    const pending = runMainV3({
      argv: ["/Applications/Botling 3.app/Contents/MacOS/Botling 3", "--botlingd", "start"],
      platform: "darwin",
      env: { BOTLING_SERVER_DATA_DIR: "/tmp/v3-srv" },
      electron: mockElectron as any,
      root: appDir,
      outDir: "/app.asar/out",
      runServerCli,
    });

    await flush();
    expect(order).toEqual(["setActivationPolicy", "dock.hide", "whenReady.called"]);
    expect(runServerCli).not.toHaveBeenCalled();

    releaseReady();
    await pending;

    expect(order).toEqual(["setActivationPolicy", "dock.hide", "whenReady.called", "whenReady.resolved", "runServerCli"]);
    expect(runServerCli).toHaveBeenCalledWith(["start"], {
      packaged: true,
      appId: v3Config.appId,
      outDir: "/app.asar/out",
      electronUtility: { utilityProcess, MessageChannelMain },
    });
  });

  it("does not await whenReady or forward electronUtility when unpackaged", async () => {
    const whenReady = vi.fn(() => { throw new Error("whenReady should not run when unpackaged"); });
    const runServerCli = vi.fn(async () => undefined);
    await runMainV3({
      argv: ["electron", ".", "--botlingd", "start"],
      platform: "darwin",
      env: { BOTLING_SERVER_DATA_DIR: "/tmp/v3-dev" },
      electron: {
        app: {
          isPackaged: false,
          isReady: () => false,
          whenReady,
        },
        utilityProcess: { fork: vi.fn() },
        MessageChannelMain: vi.fn(),
      } as any,
      outDir: "/repo/desktop/out",
      runServerCli,
    });
    expect(whenReady).not.toHaveBeenCalled();
    expect(runServerCli).toHaveBeenCalledWith(["start"], {
      packaged: false,
      appId: undefined,
      outDir: "/repo/desktop/out",
    });
  });

  it("loads the window main only when --botlingd is absent", async () => {
    const runServerCli = vi.fn(async () => undefined);
    const loadWindowMain = vi.fn();
    await runMainV3({
      argv: ["/Applications/Botling 3.app/Contents/MacOS/Botling 3"],
      runServerCli,
      loadWindowMain,
    });
    expect(loadWindowMain).toHaveBeenCalledTimes(1);
    expect(runServerCli).not.toHaveBeenCalled();
  });

  function writeElectronProbe(dir: string, bundleFile: string): string {
    const probeFile = join(dir, "probe.cjs");
    writeFileSync(
      probeFile,
      [
        "const Module = require('node:module');",
        "const origLoad = Module._load;",
        "Module._load = function(request, parent, isMain) {",
        "  const mod = origLoad.apply(this, arguments);",
        "  if (request === 'electron' && mod && typeof mod === 'object') {",
        "    const origDock = mod.app.dock;",
        "    const wrappedDock = origDock ? new Proxy(origDock, {",
        "      get(target, prop) {",
        "        if (prop === 'hide') return () => { process.stdout.write('probe:dock.hide\\n'); return target.hide(); };",
        "        const val = Reflect.get(target, prop, target);",
        "        return typeof val === 'function' ? val.bind(target) : val;",
        "      }",
        "    }) : undefined;",
        "    const wrappedApp = new Proxy(mod.app, {",
        "      get(target, prop) {",
        "        if (prop === 'requestSingleInstanceLock') return () => { throw new Error('single-instance lock called'); };",
        "        if (prop === 'dock') return wrappedDock;",
        "        const val = Reflect.get(target, prop, target);",
        "        return typeof val === 'function' ? val.bind(target) : val;",
        "      }",
        "    });",
        "    return new Proxy(mod, {",
        "      get(target, prop) {",
        "        if (prop === 'BrowserWindow') throw new Error('BrowserWindow accessed');",
        "        if (prop === 'app') return wrappedApp;",
        "        return Reflect.get(target, prop, target);",
        "      }",
        "    });",
        "  }",
        "  return mod;",
        "};",
        `require(${JSON.stringify(bundleFile)});`,
      ].join("\n"),
    );
    return probeFile;
  }

  it.skipIf(process.platform !== "darwin")("bundled main-v3 runs --botlingd status and start under Electron without BrowserWindow, single-instance lock, or Dock", async () => {
    const work = tempDir("main-v3-electron");
    const bundleFile = join(desktopRoot, "out/main-v3/main.cjs");
    const { buildMainV3 } = await import("../../build.mjs" as string) as {
      buildMainV3: (opts: { root: string; outfile: string }) => Promise<unknown>;
    };
    await buildMainV3({ root: desktopRoot, outfile: bundleFile });
    const probeFile = writeElectronProbe(work, bundleFile);
    const electronBin = req("electron") as unknown as string;

    const statusDataDir = join(work, "status-data");
    const statusRes = spawnSync(electronBin, [probeFile, "--botlingd", "status"], {
      env: botlingdEnv(statusDataDir),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(statusRes.error).toBeUndefined();
    expect(statusRes.stderr).not.toContain("BrowserWindow accessed");
    expect(statusRes.stderr).not.toContain("single-instance lock called");
    expect(statusRes.status).toBe(0);
    if (process.platform === "darwin") expect(statusRes.stdout).toContain("probe:dock.hide");
    expect(statusRes.stdout).toContain("botlingd is not running.");

    const startDataDir = join(work, "start-data");
    const child = spawn(electronBin, [probeFile, "--botlingd", "start"], {
      env: botlingdEnv(startDataDir),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolveClose) => child.once("close", resolveClose));
    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const timer = setTimeout(() => rejectReady(new Error(`electron --botlingd start timed out: ${stderr}`)), 30_000);
        createInterface({ input: child.stdout }).on("line", (line) => {
          stdout += `${line}\n`;
          if (line.startsWith("ready ")) { clearTimeout(timer); resolveReady(); }
        });
        child.once("close", (code) => { clearTimeout(timer); rejectReady(new Error(`electron --botlingd start exited ${code}: ${stderr}`)); });
      });
      expect(stderr).not.toContain("BrowserWindow accessed");
      expect(stderr).not.toContain("single-instance lock called");
      if (process.platform === "darwin") expect(stdout).toContain("probe:dock.hide");
      expect(stdout).toContain(`ready ${join(startDataDir, "botlingd.sock")}`);
    } finally {
      child.kill("SIGTERM");
      expect(await closed).toBe(0);
    }
  }, 60_000);
});

describe("M6-07c re-review H1: packaged botlingd names this build's own commands", () => {
  const execPath = "/Applications/Botling 3.app/Contents/MacOS/Botling 3";
  const self = `env -u ELECTRON_RUN_AS_NODE '${execPath}'`;
  async function run(packaged: boolean, env: Record<string, string | undefined>) {
    await runMainV3({
      argv: [execPath, "--botlingd", "start"], platform: "linux", env, execPath,
      electron: { app: { isPackaged: packaged, whenReady: async () => undefined } } as any,
      root: tempDir("pkg-cmds"), outDir: "/app.asar/out", runServerCli: vi.fn(async () => undefined),
    });
  }

  it("replaces scrubbed or inherited commands, so the core never runs ELECTRON_RUN_AS_NODE=1 <app> <script>", async () => {
    const env: Record<string, string | undefined> = {
      BOTLING_SERVER_DATA_DIR: "/tmp/v3-srv", BOTLING_CHECK_COMMAND: "evil --check", BOTLING_APP_COMMAND: "evil",
    };
    await run(true, env);
    expect(env.BOTLING_APP_COMMAND).toBe(self);
    expect(env.BOTLING_CHECK_COMMAND).toBe(`${self} --check-plugin`);
    expect(env.BOTLING_SHOT_COMMAND).toBe(`${self} --component-shot`);

    // What the core makes of that environment (Maintainer's plugin check, the bots' --render-report).
    const { coreProcessOptions } = await import("../../src/core/core-process");
    const options = coreProcessOptions({
      env: { ...env, BOTLING_CORE_PROBE: "1" } as NodeJS.ProcessEnv, dataDir: tempDir("pkg-cmds-core"), outDir: "/app.asar/out",
      emit: () => undefined, log: () => undefined, node: null, sealer: null, app: undefined as never,
    });
    const report = options.runCommand?.({ script: "/x/report.cjs", flag: "--render-report" }) ?? "";
    for (const line of [options.checkCommand ?? "", report]) {
      expect(line.startsWith(self)).toBe(true);
      expect(line).not.toContain("ELECTRON_RUN_AS_NODE=1");
    }
  });

  it("leaves a development run's commands alone", async () => {
    const env: Record<string, string | undefined> = { BOTLING_SERVER_DATA_DIR: "/tmp/v3-srv", BOTLING_CHECK_COMMAND: "dev --check" };
    await run(false, env);
    expect(env.BOTLING_CHECK_COMMAND).toBe("dev --check");
    expect(env.BOTLING_APP_COMMAND).toBeUndefined();
  });
});
