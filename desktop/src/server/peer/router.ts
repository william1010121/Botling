// `/v3/ws` carries device sessions and peer-server sessions (M3 step 3, protocol v1 §6.1: one tailnet transport for
// server ↔ server and FE ↔ server). The first frame on a socket is an HS1; its clear mode byte picks the acceptor:
// KK → the peer acceptor (server/peer), anything else → the device acceptor (server/session RemoteSessions). The byte
// grants nothing: each acceptor runs its own roster check (a device that dials KK fails the server check, a server
// that dials IK fails the device check), and nothing past the handshake is parsed before it passes.
import { hs1Mode, type SessionTransport } from "../../session";

/** What `/v3/ws` (server/net/ws.ts) needs of an accepted session. */
export interface AcceptedSession {
  readonly link: { readonly established: Promise<unknown> };
  receive(frame: Uint8Array): void;
  transportClosed(): void;
}

export interface DeviceAcceptor { accept(transport: SessionTransport, kind: "tailnet"): AcceptedSession }
export interface PeerAcceptor { accept(transport: SessionTransport): AcceptedSession }

/** A socket that sends no first frame within this time is closed (the acceptors' own handshake timers start later). */
export const FIRST_FRAME_TIMEOUT_MS = 15_000;

export class SessionRouter {
  constructor(private readonly devices: DeviceAcceptor, private readonly peers: PeerAcceptor | null, private readonly firstFrameMs = FIRST_FRAME_TIMEOUT_MS) {}

  accept(transport: SessionTransport, kind: "tailnet"): AcceptedSession {
    let target: AcceptedSession | null = null;
    let ended = false;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const established = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
    established.catch(() => undefined);
    const timer = setTimeout(() => {
      if (target || ended) return;
      ended = true;
      reject(new Error("no handshake on this socket"));
      transport.close();
    }, this.firstFrameMs);
    timer.unref?.();
    return {
      link: { established },
      receive: (frame) => {
        if (ended) return;
        if (!target) {
          clearTimeout(timer);
          target = hs1Mode(frame) === "kk" && this.peers ? this.peers.accept(transport) : this.devices.accept(transport, kind);
          target.link.established.then(resolve, reject);
        }
        target.receive(frame);
      },
      transportClosed: () => {
        if (target) { target.transportClosed(); return; }
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        reject(new Error("the socket closed before a handshake"));
      },
    };
  }
}
