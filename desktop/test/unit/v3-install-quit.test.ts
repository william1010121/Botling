// Installing a developer build in Botling 3 (botling.dev's `<install-build>`): botlingd runs the core, so the app the
// install script waits for is botlingd itself. Once the script is started, the window is asked to quit from inside its own
// process (`shell.quit`, never an AppleEvent), and when it has gone botlingd stops itself the way `botlingd stop` does.
// A new build counts as up only once a window attached to its botlingd. No Electron, no real app is quit.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppWorld } from "../../src/core/plugins/app-seam";
import { ServerClient } from "../../src/main-v3/server-client";
import type { Message } from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { ShellBridge, appBundleOf, type ShellWindow } from "../../src/server/shell-bridge";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop, until } from "../helpers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const step of cleanups.splice(0).reverse()) await step();
});

/** A window that answers `shell.quit` like main does (ok, then it goes) unless told to stay. */
function fakeWindow(bridge: ShellBridge, options: { stays?: boolean } = {}) {
  const got: Message[] = [];
  const window: ShellWindow = {
    send(message) {
      got.push(message);
      if (message.t === "shell.quit") {
        queueMicrotask(() => {
          bridge.answer(window, { t: "shell.done", req: message.req, ok: true });
          if (!options.stays) setTimeout(() => bridge.detach(window), 5);
        });
      }
      return true;
    },
  };
  return { window, got };
}

describe("the shell bridge in an install (server/shell-bridge.ts)", () => {
  it("tells the core about botlingd: its pid, its bundle and data folder, beside the app's data folder", () => {
    const bridge = new ShellBridge({ appDataDir: "/app", pid: 77, bundle: "/A/Botling 3.app", serverDataDir: "/srv" });
    expect(bridge.appBridge()).toMatchObject({ pid: 77, dataDir: "/app", bundle: "/A/Botling 3.app", server: { dataDir: "/srv" } });
    expect(new ShellBridge().appBridge()).toMatchObject({ pid: null, bundle: null, server: null });
  });

  it("asks every attached window to quit, waits until they have gone, then stops botlingd (once)", async () => {
    const stopServer = vi.fn();
    const bridge = new ShellBridge({ stopServer, quitWaitMs: 5_000 });
    const one = fakeWindow(bridge);
    const two = fakeWindow(bridge);
    bridge.attach(one.window);
    bridge.attach(two.window);
    const quitting = bridge.appBridge().quitForInstall!();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(one.got.map((message) => message.t)).toEqual(["shell.quit"]);
    expect(two.got.map((message) => message.t)).toEqual(["shell.quit"]);
    expect(stopServer).not.toHaveBeenCalled();
    await quitting;
    expect(bridge.hasWindow).toBe(false);
    expect(stopServer).toHaveBeenCalledTimes(1);
  });

  it("a window that does not go is waited for only so long; with no window botlingd stops at once", async () => {
    vi.useFakeTimers();
    const stopServer = vi.fn();
    const bridge = new ShellBridge({ stopServer, quitWaitMs: 30_000 });
    bridge.attach(fakeWindow(bridge, { stays: true }).window);
    const quitting = bridge.appBridge().quitForInstall!();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopServer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await quitting;
    expect(stopServer).toHaveBeenCalledTimes(1);

    const lone = vi.fn();
    await new ShellBridge({ stopServer: lone }).appBridge().quitForInstall!();
    expect(lone).toHaveBeenCalledTimes(1);
  });

  it("`windowAttached` waits for a window (a new build is up only with one)", async () => {
    const bridge = new ShellBridge();
    let attached = false;
    void bridge.appBridge().windowAttached!().then(() => { attached = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(attached).toBe(false);
    bridge.attach(fakeWindow(bridge).window);
    await vi.waitFor(() => expect(attached).toBe(true));
    await expect(bridge.appBridge().windowAttached!()).resolves.toBeUndefined();
  });

  it("botlingd's bundle is the .app around its program, only for a packaged macOS run", () => {
    expect(appBundleOf("/Users/u/Applications/Botling 3.app/Contents/MacOS/Botling 3", true, "darwin")).toBe("/Users/u/Applications/Botling 3.app");
    expect(appBundleOf("/Users/u/Applications/Botling 3.app/Contents/MacOS/Botling 3", false, "darwin")).toBeNull();
    expect(appBundleOf("/Users/u/Applications/Botling 3.app/Contents/MacOS/Botling 3", true, "linux")).toBeNull();
    expect(appBundleOf("/usr/local/bin/node", true, "darwin")).toBeNull();
    expect(appBundleOf("/x/Botling 3.app/Contents/Frameworks/Helper", true, "darwin")).toBeNull();
  });
});

describe("botlingd in an install (server/botlingd.ts)", () => {
  it("installAndRestart starts the script, the window quits itself, then botlingd stops itself; the state names botlingd", async () => {
    const root = testRoot("v3-install");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const dataDir = join(root, "data");
    const appDir = join(root, "app");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    const stops: string[] = [];
    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0", BOTLING_APP_DATA_DIR: appDir }),
      outDir: join(desktop, "out"),
      log: () => {},
      stopSelf: () => { stops.push("stop"); },
    });
    cleanups.push(() => daemon.stop());

    const ops: string[] = [];
    const window = new ServerClient(
      {
        script: join(desktop, "out", "core", "main.cjs"), env: { BOTLING_APP_DATA_DIR: appDir, BOTLING_SERVER_DATA_DIR: dataDir }, onEvent: () => undefined, audit: () => undefined,
        // As main does: answer, then quit from inside the process (here: the link closes).
        app: async (op) => { ops.push(op); if (op === "quit") setTimeout(() => { void window.stop(); void window.linkForTests?.close(); }, 20); return { ok: true }; },
      },
      { launch: () => { throw new Error("unexpected launch"); } },
    );
    cleanups.push(async () => { await window.stop().catch(() => undefined); await window.linkForTests?.close().catch(() => undefined); });
    window.start();
    await window.ready();
    await until(() => (daemon.shell.hasWindow ? true : null), { timeout: 10_000, what: "window attached" });

    const world = (daemon.core.plugins as unknown as { options: { world: { app: AppWorld } } }).options.world.app;
    const state = world.state();
    expect(state).toMatchObject({ pid: process.pid, dataDir, appDataDir: appDir, bundle: null, server: { dataDir } });

    // The install script botling.dev wrote (here one that only says it ran).
    const folder = join(dataDir, "self-update");
    mkdirSync(folder, { recursive: true });
    const marker = join(root, "ran");
    writeFileSync(join(folder, "install.sh"), `#!/bin/bash\necho "$@" > "${marker}"\n`, { mode: 0o700 });
    const command = ["/usr/bin/nohup", "/bin/bash", join(folder, "install.sh"), String(process.pid), "/A/Botling 3.app", "/B/Botling 3.app", "/b", "/h", "/r", "120", appDir, "/A/Botling 3.app", dataDir];
    world.installAndRestart(command, join(folder, "install.log"));

    await until(() => (existsSync(marker) ? true : null), { timeout: 10_000, what: "install script ran" });
    expect(readFileSync(marker, "utf8").trim()).toBe(command.slice(3).join(" "));
    await until(() => (stops.length ? true : null), { timeout: 40_000, what: "botlingd stopped itself" });
    expect(ops).toEqual(["quit"]);
    expect(daemon.shell.hasWindow).toBe(false);
    expect(stops).toEqual(["stop"]);
  }, 60_000);
});
