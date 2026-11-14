// The CLI's side of the local socket for `admin` requests (`botlingd pair`, `devices`, `revoke-device`, the status
// note): a front end like any other on botlingd's Unix socket (hello with the local token), which sends `admin` and
// hears `admin.event`. It dials with the desktop window's own local-socket dial (main-v3/unix-dial.ts), so botlingd's
// only socket writer stays session.ts. Nothing here logs a request or an answer (they carry the recovery code and
// pairing links).
import { randomBytes } from "node:crypto";
import type { FeSocket } from "../../fe-link";
import { unixDial } from "../../main-v3/unix-dial";
import { decodeFrame, encodeFrame, type AdminEvent, type AdminOp, type Message } from "../../protocol";

const LOCAL = { local: true } as const;

export class AdminRefused extends Error {
  constructor(message: string) { super(message); this.name = "AdminRefused"; }
}

export class AdminClient {
  private readonly waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(event: AdminEvent | null) => void>();
  private readonly events: AdminEvent[] = [];
  private welcomed: (() => void) | null = null;
  private failed: ((error: Error) => void) | null = null;
  private closedFlag = false;
  private n = 0;

  private socket: FeSocket | null = null;

  private constructor() {}

  /** Connects and says hello with the local token. */
  static async connect(path: string, token: string, timeoutMs = 10_000): Promise<AdminClient> {
    const client = new AdminClient();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("botlingd did not answer on its socket")); client.close(); }, timeoutMs);
      timer.unref?.();
      client.welcomed = () => { clearTimeout(timer); resolve(); };
      client.failed = (error) => { clearTimeout(timer); reject(error); };
      client.socket = unixDial({ path })({
        open: () => {
          client.send({
            t: "hello", deviceId: "botlingd-cli", feVersion: "3.0.0", protocol: 1, originEpoch: randomBytes(16).toString("hex"),
            cursors: {}, outbox: [], want: [], token,
          } as Message);
        },
        frame: (frame) => client.onFrame(frame),
        close: (detail) => client.fail(new Error(`botlingd closed the session${detail ? ` (${detail})` : ""}`)),
      });
    });
    return client;
  }

  get closed(): boolean { return this.closedFlag; }

  /** One admin request; resolves with the `res` result, rejects with AdminRefused for an error `res`. */
  request(op: AdminOp, timeoutMs = 60_000): Promise<unknown> {
    const req = `a${++this.n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(req); reject(new Error(`no answer to ${op.op}`)); }, timeoutMs);
      timer.unref?.();
      this.waiting.set(req, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try {
        this.send({ t: "admin", req, op } as Message);
      } catch (error) {
        this.waiting.delete(req);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** The next admin event matching `test` (events that came before are kept and searched first). */
  nextEvent<T extends AdminEvent>(test: (event: AdminEvent) => event is T, timeoutMs: number): Promise<T | null> {
    const index = this.events.findIndex(test);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0] as T);
    return new Promise((resolve) => {
      const done = (value: T | null) => { clearTimeout(timer); this.listeners.delete(listener); resolve(value); };
      const listener = (event: AdminEvent | null) => {
        if (event === null) { done(null); return; }
        if (!test(event)) return;
        const at = this.events.indexOf(event);
        if (at >= 0) this.events.splice(at, 1);
        done(event);
      };
      const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
      timer.unref?.();
      this.listeners.add(listener);
      if (this.closedFlag) done(null);
    });
  }

  close(): void {
    this.closedFlag = true;
    this.socket?.close();
  }

  private send(message: Message): void {
    const encoded = encodeFrame(message, "fe", LOCAL);
    if (!encoded.ok) throw new AdminRefused(encoded.detail);
    this.socket?.send(encoded.text);
  }

  private onFrame(frame: Uint8Array | string): void {
    const decoded = decodeFrame(frame, "server", LOCAL);
    if (decoded.ok) this.onMessage(decoded.message);
  }

  private onMessage(message: Message): void {
    switch (message.t) {
      case "welcome": this.welcomed?.(); this.welcomed = null; this.failed = null; return;
      case "res": {
        const waiter = this.waiting.get(message.req);
        if (!waiter) return;
        this.waiting.delete(message.req);
        if (message.ok) waiter.resolve(message.result);
        else waiter.reject(new AdminRefused(message.error.message));
        return;
      }
      case "admin.event": {
        this.events.push(message.event);
        if (this.events.length > 100) this.events.shift();
        for (const listener of [...this.listeners]) listener(message.event);
        return;
      }
      case "bye": this.fail(new Error(`botlingd ended the session (${message.reason}${message.detail ? `: ${message.detail}` : ""})`)); return;
      default: return;
    }
  }

  private fail(error: Error): void {
    if (this.failed) { this.failed(error); this.failed = null; this.welcomed = null; }
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
    if (!this.closedFlag) { this.closedFlag = true; this.socket?.close(); }
    for (const listener of [...this.listeners]) listener(null);
  }
}
