// One front end's session on botlingd's local socket (M1 step 9, protocol v1 §5, §6.1, §8.3, §9, §11, §13.1): the
// local shell around the session core (session-core.ts, which says what each frame does).
//
//   hello (first frame; local token, constant-time compare)  → the core's welcome; the desktop window ("desktop")
//                                                              answers the core's app ops (shell bridge)
//   cmd                                                      → scope `local` (the desktop window on its own server)
//   req                                                      → read commands only (servedAsReq)
//   content.find / content.open / shell.done                 → served here only (local-only rows of the role table)
//
// Frames are length-prefixed on the socket and checked with the protocol's role table (decodeFrame "fe", local): a
// malformed, oversized or out-of-role frame ends the session with its `bye`. A front end that does not read (its socket
// buffer above `maxBuffered`) is dropped rather than let botlingd's memory grow: it re-attaches from its cursors.
//
// This file stays the only place in botlingd that writes frames to a socket (test/unit/server-session-frames.test.ts).
import type { Socket } from "node:net";
import type { Command } from "../../contract";
import { decodeFrame, encodeChunkFrame, FrameSplitter, packFrame, type CmdBody, type MessageOf, type Scope } from "../../protocol";
import type { ShellWindow } from "../shell-bridge";
import { sameToken } from "./paths";
import { errorText, MAX_BUFFERED, servedAsReq, SessionCore, type SessionHost, type SessionOptions, type ShellRefusal } from "./session-core";

export { REQ_ALSO, servedAsReq, type ContentHandler, type SessionHost, type SessionOptions } from "./session-core";

const SESSION_KIND = { local: true } as const;

export class Session extends SessionCore implements ShellWindow {
  protected readonly kind = SESSION_KIND;
  private readonly splitter = new FrameSplitter();

  constructor(private readonly socket: Socket, host: SessionHost, options: SessionOptions = {}) {
    super(host, options);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.close());
    socket.on("close", () => this.close());
    this.startTimers();
  }

  protected get writable(): boolean { return !this.socket.destroyed; }

  /**
   * Writes encoded frames in order; false when the front end does not read (it is dropped) or the session ended. The
   * only place that writes to the socket: every frame is packed (and its size checked) before any is written, so a set
   * of frames goes whole or not at all, and one over the limit is logged and refused, never attempted.
   */
  protected writeTexts(texts: string[], t: string, what?: string): boolean {
    return this.writeFrames(texts, t, what);
  }

  protected writeChunk(message: MessageOf<"content.chunk">): boolean {
    if (this.state === "closed" || this.socket.destroyed) return false;
    const encoded = encodeChunkFrame(message, "server", SESSION_KIND);
    if (!encoded.ok) {
      this.host.log(`session: cannot send content.chunk (${message.req}): ${encoded.detail}`);
      return false;
    }
    return this.writeFrames([encoded.bytes], "content.chunk", message.req);
  }

  private writeFrames(frames: Array<string | Uint8Array>, t: string, what?: string): boolean {
    if (this.state === "closed" || this.socket.destroyed) return false;
    if (this.socket.writableLength > (this.options.maxBuffered ?? MAX_BUFFERED)) {
      this.host.log(`session ${this.deviceId ?? "?"}: dropped, it does not read (${this.socket.writableLength} bytes waiting)`);
      this.close();
      return false;
    }
    let packed: Uint8Array[];
    try {
      packed = frames.map((frame) => packFrame(frame));
    } catch (error) {
      this.host.log(`session: cannot send ${t}${what ? ` (${what})` : ""}: ${errorText(error)}`);
      return false;
    }
    for (const frame of packed) this.socket.write(frame);
    this.lastSent = Date.now();
    return true;
  }

  protected endTransport(): void { this.socket.end(); }

  protected destroyTransport(): void { if (!this.socket.destroyed) this.socket.destroy(); }

  protected closing(): void { this.host.shell.detach(this); }

  protected checkHello(hello: MessageOf<"hello">): ShellRefusal | null {
    if (!sameToken(hello.token, this.host.token())) return { reason: "token", detail: "the local token does not match (read botlingd.token again)" };
    return null;
  }

  // The desktop window answers the core's app ops (browser, screenshot, install, quit).
  protected opened(hello: MessageOf<"hello">): void { if (hello.deviceId === "desktop") this.host.shell.attach(this); }

  protected cmdScope(_body: CmdBody): { scope: Scope } { return { scope: "local" }; }

  protected reqRefusal(cmd: Command): { code: "bad_request"; message: string } | null {
    return servedAsReq(cmd.type) ? null : { code: "bad_request", message: `${cmd.type} changes state: send it as a cmd, not a req.` };
  }

  private onData(chunk: Buffer): void {
    if (this.state === "closed") return;
    this.lastHeard = Date.now();
    const split = this.splitter.push(chunk);
    if (!split.ok) { this.bye("too-large", split.detail); return; }
    for (const frame of split.frames) {
      if ((this.state as string) === "closed") return;
      const decoded = decodeFrame(frame, "fe", SESSION_KIND);
      if (!decoded.ok) { this.send(decoded.bye); this.socket.end(); this.close(); return; }
      try {
        this.onMessage(decoded.message);
      } catch (error) {
        this.frameFailed(decoded.message, error);
      }
    }
  }
}
