// The 2.x core's app ops in botlingd (M1 step 9): where 2.x asked Electron main over its utility-process port, botlingd
// asks the attached Botling 3 window over the local socket with `shell.*` and waits for its `shell.done` (protocol v1
// §5.4, the step 11 window answers them with the same 2.x app ops).
//
// - The window is the most recently attached local session of the desktop front end (`deviceId` "desktop"); when it
//   detaches, the one before it (if still attached) takes over.
// - No window: the op fails at once. A bot's browser and screenshot tools then say to open Botling 3 (the 2.x tools pass
//   `error` on to the bot, browser-tools.ts).
// - A request waits 30 s for its answer (installing a release: 20 min, it downloads and verifies first); a window that
//   detaches meanwhile fails its requests.
import type { AppAnswer, AppOp } from "../core/server";
import type { Message, MessageOf } from "../protocol";

/** What a session gives the bridge: a way to send the window a frame (false: not sent, the session is gone). */
export interface ShellWindow {
  send(message: Message): boolean;
}

export const NO_WINDOW_ERROR = "Open Botling 3 to use the browser or take a screenshot: no Botling 3 window is attached to this server.";
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
}

interface Waiting {
  window: ShellWindow;
  resolve(answer: AppAnswer): void;
  timer: NodeJS.Timeout;
}

export class ShellBridge {
  private readonly windows: ShellWindow[] = [];
  private readonly waiting = new Map<string, Waiting>();
  private counter = 0;

  constructor(private readonly options: ShellBridgeOptions = {}) {}

  /** A desktop window attached (its hello was welcomed). */
  attach(window: ShellWindow): void {
    this.detachOnly(window);
    this.windows.push(window);
  }

  /** The window's session ended: its unanswered requests fail. */
  detach(window: ShellWindow): void {
    this.detachOnly(window);
    for (const [req, waiting] of [...this.waiting]) if (waiting.window === window) this.settle(req, { ok: false, error: DETACHED_ERROR });
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
  appBridge(): { pid: null; dataDir: string | null; bundle: null; request: (op: AppOp, args?: Record<string, string>) => Promise<AppAnswer> } {
    return { pid: null, dataDir: this.options.appDataDir ?? null, bundle: null, request: (op, args) => this.request(op, args) };
  }

  request(op: AppOp, args?: Record<string, string>): Promise<AppAnswer> {
    const window = this.windows[this.windows.length - 1];
    if (!window) return Promise.resolve({ ok: false, error: NO_WINDOW_ERROR });
    const req = `shell-${++this.counter}`;
    return new Promise<AppAnswer>((resolve) => {
      const wait = op === "installRelease" ? this.options.installTimeoutMs ?? 20 * 60_000 : this.options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => this.settle(req, { ok: false, error: NO_ANSWER_ERROR }), wait);
      timer.unref?.();
      this.waiting.set(req, { window, resolve, timer });
      const sent = window.send({ t: MESSAGE_OF[op], req, ...(args && Object.keys(args).length ? { args } : {}) } as Message);
      if (!sent) this.settle(req, { ok: false, error: DETACHED_ERROR });
    });
  }

  /** Shutdown: every request fails. */
  close(): void {
    for (const req of [...this.waiting.keys()]) this.settle(req, { ok: false, error: DETACHED_ERROR });
    this.windows.length = 0;
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
