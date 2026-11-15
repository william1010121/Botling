// The 2.x core's app ops in botlingd (M1 step 9): where 2.x asked Electron main over its utility-process port, botlingd
// asks the attached Botling 3 window over the local socket with `shell.*` and waits for its `shell.done` (protocol v1
// §5.4, the step 11 window answers them with the same 2.x app ops).
//
// - The window is the most recently attached local session of the desktop front end (`deviceId` "desktop"); when it
//   detaches, the one before it (if still attached) takes over.
// - No window: the op fails at once. A bot's browser and screenshot tools then say to open Botling 3 (the 2.x tools pass
//   `error` on to the bot, browser-tools.ts).
// - Plugin secrets (D74 / M6-06): `sealer()` asks the attached window to seal and open with `safeStorage` (`shell.seal`
//   / `shell.open`); when no window is attached, it rejects with `NO_SAFE_STORAGE`. Never logs secret payloads.
// - A quit from macOS (`quit app "Botling 3"`, Activity Monitor's Quit) can reach the packaged botlingd instead of the
//   window: both are the same app bundle. `answerSystemQuit` passes it on to the attached windows (`shell.quit`, which
//   they answer like Cmd+Q) and botlingd keeps running, as when the window quits; with no window attached, or while
//   macOS logs out or shuts down, botlingd stops the normal way (main-v3/main.ts catches Electron's `before-quit`).
// - A request waits 30 s for its answer (installing a release: 20 min, it downloads and verifies first); a window that
//   detaches meanwhile fails its requests.
// - Installing a developer build (botling.dev's `<install-build>`, core/self-update.ts `installAndQuit`): the core is told
//   botlingd's pid, bundle and data folder (the install script waits for botlingd and reopens the window on that folder).
//   `quitForInstall` asks every attached window to quit from inside its own process (`shell.quit`, main's `app.quit()`;
//   never an AppleEvent), waits until they have gone (at most `quitWaitMs`), then stops botlingd (`stopServer`, the same
//   SIGTERM as `botlingd stop`). `windowAttached` resolves once a window is here: a new build counts as up only then.
import type { Sealer } from "../core/plugins/secrets";
import type { AppAnswer, AppOp } from "../core/server";
import type { Message, MessageOf } from "../protocol";
import { dirname } from "node:path";

/** What a session gives the bridge: a way to send the window a frame (false: not sent, the session is gone). */
export interface ShellWindow {
  send(message: Message): boolean;
}

export const NO_WINDOW_ERROR = "Open Botling 3 to use the browser or take a screenshot: no Botling 3 window is attached to this server.";
export const NO_SAFE_STORAGE = "Plugin secrets need the Botling 3 window's safe storage (the Keychain), which this M1 server does not reach yet; open Botling 2.x for plugins that keep secrets.";
const DETACHED_ERROR = "The Botling 3 window closed before it answered.";
const NO_ANSWER_ERROR = "The Botling 3 window did not answer.";

const MESSAGE_OF: Record<AppOp, "shell.screenshot" | "shell.browser" | "shell.install" | "shell.quit"> = {
  screenshot: "shell.screenshot", browser: "shell.browser", installRelease: "shell.install", quit: "shell.quit",
};

export interface ShellBridgeOptions {
  /** The app's data folder the core shows the developer tools (`BOTLING_APP_DATA_DIR`), or null. */
  appDataDir?: string | null;
  timeoutMs?: number;
  installTimeoutMs?: number;
  /** botlingd's pid, the process an install script waits for (null: none told). */
  pid?: number | null;
  /** The app bundle botlingd runs from (`appBundleOf`; null: not from a bundle, as in development). */
  bundle?: string | null;
  /** botlingd's data folder (null: none told). */
  serverDataDir?: string | null;
  /** Stops botlingd for an install, once the windows have gone. */
  stopServer?: () => void;
  /** How long an install waits for the windows to quit before botlingd stops anyway (default 30 s). */
  quitWaitMs?: number;
}

/** The `.app` bundle around a packaged macOS program (`<bundle>.app/Contents/MacOS/<name>`), else null. */
export function appBundleOf(execPath: string, packaged: boolean, platform: NodeJS.Platform = process.platform): string | null {
  if (!packaged || platform !== "darwin") return null;
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  if (!macos.endsWith("/MacOS") || !contents.endsWith("/Contents") || !bundle.endsWith(".app")) return null;
  return bundle;
}

interface Waiting {
  window: ShellWindow;
  resolve(answer: AppAnswer): void;
  timer: NodeJS.Timeout;
}

export class ShellBridge {
  private readonly windows: ShellWindow[] = [];
  private readonly waiting = new Map<string, Waiting>();
  private readonly attachListeners = new Set<() => void>();
  private readonly detachListeners = new Set<() => void>();
  private counter = 0;

  constructor(private readonly options: ShellBridgeOptions = {}) {}

  /** A desktop window attached (its hello was welcomed). */
  attach(window: ShellWindow): void {
    this.detachOnly(window);
    this.windows.push(window);
    for (const listener of [...this.attachListeners]) {
      try { listener(); } catch { /* listener failure must not break window attach */ }
    }
  }

  /** Called whenever a desktop window attaches to this bridge. */
  onAttach(listener: () => void): () => void {
    this.attachListeners.add(listener);
    return () => { this.attachListeners.delete(listener); };
  }

  /** The window's session ended: its unanswered requests fail. */
  detach(window: ShellWindow): void {
    this.detachOnly(window);
    for (const [req, waiting] of [...this.waiting]) if (waiting.window === window) this.settle(req, { ok: false, error: DETACHED_ERROR });
    for (const listener of [...this.detachListeners]) {
      try { listener(); } catch { /* a listener never breaks a detach */ }
    }
  }

  get hasWindow(): boolean { return this.windows.length > 0; }

  /** The window's `shell.done`; an answer to nothing (late, or another window's) is ignored. */
  answer(from: ShellWindow, done: MessageOf<"shell.done">): void {
    const waiting = this.waiting.get(done.req);
    if (!waiting || waiting.window !== from) return;
    this.settle(done.req, {
      ok: done.ok,
      ...(done.file !== undefined ? { file: done.file } : {}),
      ...(done.error !== undefined ? { error: done.error } : {}),
      ...(done.data !== undefined ? { data: done.data } : {}),
    });
  }

  /** The core's `app` option (CoreOptions.app). */
  appBridge(): {
    pid: number | null; dataDir: string | null; bundle: string | null; server: { dataDir: string } | null;
    request: (op: AppOp, args?: Record<string, string>) => Promise<AppAnswer>;
    quitForInstall: () => Promise<void>;
    windowAttached: () => Promise<void>;
  } {
    const serverDataDir = this.options.serverDataDir ?? null;
    return {
      pid: this.options.pid ?? null, dataDir: this.options.appDataDir ?? null, bundle: this.options.bundle ?? null,
      server: serverDataDir ? { dataDir: serverDataDir } : null,
      request: (op, args) => this.request(op, args),
      quitForInstall: () => this.quitForInstall(),
      windowAttached: () => this.windowAttached(),
    };
  }

  /** An install: every attached window quits itself; once they have gone (or `quitWaitMs` passed), botlingd stops. */
  async quitForInstall(): Promise<void> {
    const windows = [...this.windows];
    const wait = this.options.quitWaitMs ?? 30_000;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.detachListeners.delete(check); resolve(); };
      const check = () => { if (!windows.some((window) => this.windows.includes(window))) done(); };
      const timer = setTimeout(done, wait);
      timer.unref?.();
      this.detachListeners.add(check);
      // Each window answers, then quits (main's `app.quit()`); its session ending is what counts.
      for (const window of windows) void this.sendRequest(window, (req) => ({ t: "shell.quit", req }), wait);
      check();
    });
    this.options.stopServer?.();
  }

  /** Resolves once a window is attached (at once when one is). */
  windowAttached(): Promise<void> {
    if (this.windows.length) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onAttach(() => { off(); resolve(); });
    });
  }

  /** D74 (M6-06): seals and opens plugin secrets through the attached Botling 3 window's safe storage. */
  sealer(): Sealer {
    const askSecret = async (build: (req: string) => Message, extract: (data: unknown) => string | null): Promise<string> => {
      const window = this.windows[this.windows.length - 1];
      if (!window) throw new Error(NO_SAFE_STORAGE);
      const answer = await this.sendRequest(window, build, this.options.timeoutMs ?? 30_000);
      if (!answer.ok) throw new Error(answer.error || NO_ANSWER_ERROR);
      const value = extract(answer.data);
      if (value === null) throw new Error("The Botling 3 window returned an invalid secret answer.");
      return value;
    };
    return {
      seal: (text) => askSecret(
        (req) => ({ t: "shell.seal", req, text }),
        (data) => (data && typeof data === "object" && typeof (data as { sealed?: unknown }).sealed === "string" ? (data as { sealed: string }).sealed : null),
      ),
      open: (sealed) => askSecret(
        (req) => ({ t: "shell.open", req, sealed }),
        (data) => (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string" ? (data as { text: string }).text : null),
      ),
    };
  }

  /**
   * Asks every attached window to quit (`shell.quit`, not waited for: a quitting window may not answer); returns how
   * many were sent it. Their `shell.done` answers nothing and is dropped.
   */
  quitWindows(): number {
    let sent = 0;
    for (const window of [...this.windows]) {
      if (window.send({ t: "shell.quit", req: `quit-${++this.counter}` })) sent++;
    }
    return sent;
  }

  request(op: AppOp, args?: Record<string, string>): Promise<AppAnswer> {
    const window = this.windows[this.windows.length - 1];
    if (!window) return Promise.resolve({ ok: false, error: NO_WINDOW_ERROR });
    const wait = op === "installRelease" ? this.options.installTimeoutMs ?? 20 * 60_000 : this.options.timeoutMs ?? 30_000;
    return this.sendRequest(window, (req) => ({ t: MESSAGE_OF[op], req, ...(args && Object.keys(args).length ? { args } : {}) } as Message), wait);
  }

  /** Shutdown: every request fails. */
  close(): void {
    for (const req of [...this.waiting.keys()]) this.settle(req, { ok: false, error: DETACHED_ERROR });
    this.windows.length = 0;
  }

  private sendRequest(window: ShellWindow, build: (req: string) => Message, wait: number): Promise<AppAnswer> {
    const req = `shell-${++this.counter}`;
    return new Promise<AppAnswer>((resolve) => {
      const timer = setTimeout(() => this.settle(req, { ok: false, error: NO_ANSWER_ERROR }), wait);
      timer.unref?.();
      this.waiting.set(req, { window, resolve, timer });
      const sent = window.send(build(req));
      if (!sent) this.settle(req, { ok: false, error: DETACHED_ERROR });
    });
  }

  private detachOnly(window: ShellWindow): void {
    const at = this.windows.indexOf(window);
    if (at >= 0) this.windows.splice(at, 1);
  }

  private settle(req: string, answer: AppAnswer): void {
    const waiting = this.waiting.get(req);
    if (!waiting) return;
    this.waiting.delete(req);
    clearTimeout(waiting.timer);
    waiting.resolve(answer);
  }
}

/** Called with whether macOS is logging out or shutting down (botlingd must then stop, or logout waits for it). */
export type SystemQuitListener = (systemEnding: boolean) => void;

/**
 * botlingd's answer to a quit from macOS: "kept" when attached windows got `shell.quit` (botlingd keeps running),
 * "stop" when it should stop (no window took it, or macOS is logging out or shutting down).
 */
export function answerSystemQuit(shell: Pick<ShellBridge, "quitWindows">, systemEnding: boolean, log: (line: string) => void): "kept" | "stop" {
  if (systemEnding) {
    log("macOS asked botlingd to quit while logging out or shutting down: stopping");
    return "stop";
  }
  const sent = shell.quitWindows();
  if (sent === 0) {
    log("macOS asked botlingd to quit and no Botling 3 window is attached: stopping");
    return "stop";
  }
  log(`macOS asked botlingd to quit (a quit for "Botling 3" reached this process): passed it to ${sent} Botling 3 window${sent === 1 ? "" : "s"}; botlingd keeps running (\`botlingd stop\` stops it)`);
  return "kept";
}

/** `botlingd start`: stops the normal way (`stop(0)`, as on SIGTERM) unless the daemon handed the quit to its windows. */
export function stopOnSystemQuit(
  onSystemQuit: ((listener: SystemQuitListener) => void) | undefined,
  daemon: { answerSystemQuit(systemEnding: boolean): "kept" | "stop" },
  stop: (code: number) => void,
): void {
  onSystemQuit?.((systemEnding) => {
    let answer: "kept" | "stop" = "stop";
    try { answer = daemon.answerSystemQuit(systemEnding); } catch { /* not handed on: stop rather than drop the quit */ }
    if (answer === "stop") stop(0);
  });
}
