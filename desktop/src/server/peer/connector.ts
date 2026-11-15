// How botlingd dials a peer server (M3 step 3): a WebSocket to the peer's loopback listener `/v3/ws` (Node's built-in
// WebSocket client, no dependency), one binary message per session frame, as the acceptor side (server/net/ws.ts).
import type { SessionTransport } from "../../session";

/** Socket bytes not yet flushed past which SessionLink pauses sealing and wakes on drain. */
export const WS_HIGH_WATER = 1024 * 1024;
const WS_DRAIN_POLL_MS = 5;

/** A dialled connection: a session transport whose incoming frames are handed over once the session is bound. */
export interface PeerConnection extends SessionTransport {
  bind(events: { frame(frame: Uint8Array): void; closed(): void; resume?(): void }): void;
}

export interface PeerConnector {
  /** Resolves once the connection is open; rejects when it cannot be made. */
  connect(url: string): Promise<PeerConnection>;
}

const CONNECT_TIMEOUT_MS = 10_000;

/** Dials `ws://127.0.0.1:<port>/v3/ws` addresses (config.ts `loopbackAddress` checked them). */
export const webSocketConnector: PeerConnector = {
  connect(url: string): Promise<PeerConnection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (error) { reject(error); return; }
      ws.binaryType = "arraybuffer";
      const waiting: Uint8Array[] = [];
      let bound: { frame(frame: Uint8Array): void; closed(): void; resume?(): void } | null = null;
      let closed = false;
      let opened = false;
      let paused = false;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const clearDrain = () => {
        if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
      };
      const scheduleDrain = () => {
        if (closed || drainTimer || ws.readyState !== WebSocket.OPEN) return;
        drainTimer = setTimeout(() => {
          drainTimer = null;
          if (closed || ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount < WS_HIGH_WATER) {
            paused = false;
            bound?.resume?.();
          } else {
            scheduleDrain();
          }
        }, WS_DRAIN_POLL_MS);
        drainTimer.unref?.();
      };
      const timer = setTimeout(() => { if (!opened) { try { ws.close(); } catch { /* gone */ } reject(new Error("the connection did not open in time")); } }, CONNECT_TIMEOUT_MS);
      timer.unref?.();
      const connection: PeerConnection = {
        send: (frame) => { if (!closed && ws.readyState === WebSocket.OPEN) ws.send(frame); },
        close: () => { if (closed) return; closed = true; clearDrain(); try { ws.close(1000); } catch { /* gone */ } },
        writable: () => {
          if (closed || ws.readyState !== WebSocket.OPEN) return false;
          if (ws.bufferedAmount < WS_HIGH_WATER) return true;
          paused = true;
          scheduleDrain();
          return false;
        },
        bind: (events) => {
          bound = events;
          for (const frame of waiting.splice(0)) events.frame(frame);
          if (paused && ws.bufferedAmount < WS_HIGH_WATER) {
            paused = false;
            events.resume?.();
          }
          if (closed && ws.readyState === WebSocket.CLOSED) events.closed();
        },
      };
      ws.addEventListener("open", () => { opened = true; clearTimeout(timer); resolve(connection); });
      ws.addEventListener("message", (event) => {
        if (typeof event.data === "string") { connection.close(); bound?.closed(); return; }
        const frame = new Uint8Array(event.data as ArrayBuffer);
        if (bound) bound.frame(frame); else waiting.push(frame);
      });
      ws.addEventListener("close", () => {
        closed = true;
        clearDrain();
        clearTimeout(timer);
        if (!opened) reject(new Error("the connection closed before it opened"));
        bound?.closed();
      });
      ws.addEventListener("error", () => { /* a close event follows */ });
    });
  },
};
