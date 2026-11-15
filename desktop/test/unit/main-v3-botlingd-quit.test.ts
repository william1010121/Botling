// Botling 3 install bug (2026-11-15, .bot/artifacts/install-3.0/install.log step 1): `osascript -e 'quit app "Botling 3"'`
// returned 0 but the window never quit. The packaged botlingd is the same app bundle (`Botling 3 --botlingd start`), so
// macOS may hand the AppleEvent quit to botlingd instead of the window. Electron then quit botlingd at once (no
// `daemon.stop()`, no "stopped" line), the window saw the socket drop and started a new botlingd, and the window itself
// never heard of the quit.
//
// Expected: botlingd never lets Electron end it on a quit from macOS. It passes the quit on to the attached Botling 3
// windows (`shell.quit`, which they answer like Cmd+Q) and keeps running, as it does when the window quits; with no
// window attached, or while macOS logs out or shuts down, it stops the normal way (daemon.stop, as on SIGTERM).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runMainV3, type SystemQuitListener } from "../../src/main-v3/main";
import { main as serverMain } from "../../src/server/main";
import { botlingdPaths, readToken } from "../../src/server/session";
import { ShellBridge, answerSystemQuit, stopOnSystemQuit, type ShellWindow } from "../../src/server/shell-bridge";
import type { Message } from "../../src/protocol";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import { flush } from "./fe-link-harness";

type Listener = (...args: unknown[]) => void;

/** An Electron `app` and `powerMonitor` that record their listeners (no Electron). */
function fakeElectron(options: { packaged?: boolean } = {}) {
  const appListeners = new Map<string, Listener[]>();
  const powerListeners = new Map<string, Listener[]>();
  const add = (map: Map<string, Listener[]>) => (event: string, listener: Listener) => {
    map.set(event, [...(map.get(event) ?? []), listener]);
  };
  const app = {
    isPackaged: options.packaged ?? true,
    isReady: () => false,
    whenReady: () => Promise.resolve(),
    setActivationPolicy: () => {},
    dock: { hide: () => {} },
    on: vi.fn(add(appListeners)),
  };
  const powerMonitor = { on: vi.fn(add(powerListeners)) };
  /** What macOS's quit AppleEvent turns into in Electron: `before-quit`; returns whether a listener prevented it. */
  const quitFromMacOS = (): boolean => {
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const listener of appListeners.get("before-quit") ?? []) listener(event);
    return prevented;
  };
  const powerOff = () => { for (const listener of powerListeners.get("shutdown") ?? []) listener({ preventDefault: () => {} }); };
  return { electron: { app, powerMonitor }, appListeners, quitFromMacOS, powerOff };
}

const BOTLINGD = "/Applications/Botling 3.app/Contents/MacOS/Botling 3";

async function startBotlingd(fake: ReturnType<typeof fakeElectron>, command = "start") {
  let registered: ((listener: SystemQuitListener) => void) | undefined;
  const runServerCli = vi.fn(async (_argv: string[], options: { onSystemQuit?: (listener: SystemQuitListener) => void }) => {
    registered = options.onSystemQuit;
  });
  await runMainV3({
    argv: [BOTLINGD, "--botlingd", command],
    platform: "darwin",
    env: { BOTLING_SERVER_DATA_DIR: "/tmp/v3-quit" },
    electron: fake.electron as never,
    root: "/nonexistent",
    outDir: "/app.asar/out",
    runServerCli: runServerCli as never,
    exit: () => {},
  });
  await flush();
  return { runServerCli, register: (listener: SystemQuitListener) => registered?.(listener), registered: () => registered };
}

describe("packaged botlingd and a quit from macOS (quit app \"Botling 3\")", () => {
  it("never lets Electron end botlingd: before-quit is prevented and handed to the server", async () => {
    const fake = fakeElectron();
    const started = await startBotlingd(fake);
    expect(started.registered()).toBeTypeOf("function");
    const heard: boolean[] = [];
    started.register((systemEnding) => heard.push(systemEnding));

    expect(fake.quitFromMacOS()).toBe(true);
    expect(heard).toEqual([false]);
    // A second quit (another osascript, Activity Monitor's Quit) is handed on too.
    expect(fake.quitFromMacOS()).toBe(true);
    expect(heard).toEqual([false, false]);
  });

  it("holds a quit that arrives while botlingd is still starting and hands it over once the server listens", async () => {
    const fake = fakeElectron();
    const started = await startBotlingd(fake);
    expect(fake.quitFromMacOS()).toBe(true);
    const heard: boolean[] = [];
    started.register((systemEnding) => heard.push(systemEnding));
    expect(heard).toEqual([false]);
  });

  it("tells the server when macOS is logging out or shutting down (powerMonitor shutdown)", async () => {
    const fake = fakeElectron();
    const started = await startBotlingd(fake);
    const heard: boolean[] = [];
    started.register((systemEnding) => heard.push(systemEnding));
    fake.powerOff();
    expect(fake.quitFromMacOS()).toBe(true);
    expect(heard).toEqual([true]);
  });

  it("adds no quit handling to one-shot commands (status, stop, ...)", async () => {
    const fake = fakeElectron();
    const started = await startBotlingd(fake, "status");
    expect(started.registered()).toBeUndefined();
    expect(fake.appListeners.get("before-quit") ?? []).toEqual([]);
  });
});

function fakeWindow(sent: Message[], attached = true): ShellWindow {
  return { send: (message) => { if (!attached) return false; sent.push(message); return true; } };
}

describe("ShellBridge.quitWindows: botlingd passes macOS's quit on to the Botling 3 windows", () => {
  it("sends shell.quit to every attached window and counts the ones that got it", () => {
    const bridge = new ShellBridge();
    const a: Message[] = [];
    const b: Message[] = [];
    const gone: Message[] = [];
    bridge.attach(fakeWindow(a));
    bridge.attach(fakeWindow(b));
    bridge.attach(fakeWindow(gone, false));
    expect(bridge.quitWindows()).toBe(2);
    expect(a.map((m) => m.t)).toEqual(["shell.quit"]);
    expect(b.map((m) => m.t)).toEqual(["shell.quit"]);
    const reqs = [...a, ...b].map((m) => (m as { req: string }).req);
    for (const req of reqs) expect(req).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    expect(new Set(reqs).size).toBe(2);
  });

  it("sends nothing and counts 0 without a window", () => {
    expect(new ShellBridge().quitWindows()).toBe(0);
  });

  it("a window's shell.done for the quit is dropped harmlessly", () => {
    const bridge = new ShellBridge();
    const sent: Message[] = [];
    const window = fakeWindow(sent);
    bridge.attach(window);
    bridge.quitWindows();
    const req = (sent[0] as { req: string }).req;
    expect(() => bridge.answer(window, { t: "shell.done", req, ok: true })).not.toThrow();
  });
});

describe("answerSystemQuit: keep running only when a window took the quit", () => {
  it("a window is attached: it gets shell.quit, botlingd keeps running and says so in its log", () => {
    const bridge = new ShellBridge();
    const sent: Message[] = [];
    bridge.attach(fakeWindow(sent));
    const log: string[] = [];
    expect(answerSystemQuit(bridge, false, (line) => log.push(line))).toBe("kept");
    expect(sent.map((m) => m.t)).toEqual(["shell.quit"]);
    expect(log.join("\n")).toMatch(/passed it to 1 Botling 3 window/);
  });

  it("no window is attached: botlingd stops", () => {
    const log: string[] = [];
    expect(answerSystemQuit(new ShellBridge(), false, (line) => log.push(line))).toBe("stop");
    expect(log.join("\n")).toMatch(/no Botling 3 window is attached/);
  });

  it("macOS is logging out or shutting down: botlingd stops even with a window attached (logout must not wait for it)", () => {
    const bridge = new ShellBridge();
    const sent: Message[] = [];
    bridge.attach(fakeWindow(sent));
    const log: string[] = [];
    expect(answerSystemQuit(bridge, true, (line) => log.push(line))).toBe("stop");
    expect(sent).toEqual([]);
    expect(log.join("\n")).toMatch(/logging out or shutting down/);
  });
});

describe("stopOnSystemQuit: botlingd start wires the quit to its normal stop", () => {
  it("stops (code 0) only when the daemon did not keep running", () => {
    let registered: SystemQuitListener | undefined;
    const answers: Array<"kept" | "stop"> = ["kept", "stop"];
    const daemon = { answerSystemQuit: vi.fn(() => answers.shift()!) };
    const stop = vi.fn();
    stopOnSystemQuit((listener) => { registered = listener; }, daemon, stop);
    registered!(false);
    expect(daemon.answerSystemQuit).toHaveBeenLastCalledWith(false);
    expect(stop).not.toHaveBeenCalled();
    registered!(true);
    expect(daemon.answerSystemQuit).toHaveBeenLastCalledWith(true);
    expect(stop).toHaveBeenCalledWith(0);
  });

  it("stops when handing the quit on throws (the quit is never dropped)", () => {
    let registered: SystemQuitListener | undefined;
    const stop = vi.fn();
    stopOnSystemQuit((listener) => { registered = listener; }, { answerSystemQuit: () => { throw new Error("socket gone"); } }, stop);
    registered!(false);
    expect(stop).toHaveBeenCalledWith(0);
  });

  it("does nothing without a quit source (not Electron, or a development run)", () => {
    expect(() => stopOnSystemQuit(undefined, { answerSystemQuit: () => "stop" }, vi.fn())).not.toThrow();
  });
});

describe("botlingd start in process: the quit reaches the real daemon (server/main.ts wiring, Botlingd.answerSystemQuit)", () => {
  it("a desktop window gets shell.quit and botlingd keeps running; once it is gone the next quit stops botlingd (daemon.stop removes the socket, exit 0)", { timeout: 60_000 }, async () => {
    const dataDir = testRoot("v3-quit-start");
    const savedEnv = { ...process.env };
    const events = ["SIGTERM", "SIGINT", "SIGHUP", "uncaughtException"] as const;
    const before = new Map(events.map((event) => [event, new Set(process.listeners(event))]));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const client = new ScriptClient("desktop");
    let listener: SystemQuitListener | undefined;
    try {
      for (const key of Object.keys(process.env)) if (key.startsWith("BOTLING_")) delete process.env[key];
      Object.assign(process.env, botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }));
      const paths = botlingdPaths(process.env);
      await serverMain(["start"], { outDir: join(__dirname, "..", "..", "out"), onSystemQuit: (next) => { listener = next; } });
      expect(listener).toBeTypeOf("function");
      await client.connect(paths.socket, readToken(paths.token)!);

      listener!(false);
      await until(() => client.received.some((m) => m.t === "shell.quit"), { what: "shell.quit at the window" });
      expect(exit).not.toHaveBeenCalled();

      client.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      listener!(false);
      listener!(false); // a second quit while stopping stops once
      await until(() => exit.mock.calls.length > 0, { timeout: 30_000, what: "botlingd to stop" });
      expect(exit.mock.calls).toEqual([[0]]);
      expect(existsSync(paths.socket)).toBe(false);
    } finally {
      client.close();
      exit.mockRestore();
      stdout.mockRestore();
      for (const event of events) for (const added of process.listeners(event)) if (!before.get(event)!.has(added)) process.removeListener(event, added as never);
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
    }
  });
});
