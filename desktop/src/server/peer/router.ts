// `/v3/ws` and the relay room carry device sessions and peer-server sessions (M3 step 3, M4-16a, protocol v1 §6.1,
// §6.3). The first frame on a transport is an HS1; its clear mode byte picks the acceptor: KK → the peer acceptor
// (server/peer), `pair` naming one of this server's join offers → server pairing (server/pairing/join.ts, M3 step 4),
// anything else → the device acceptor (server/session RemoteSessions). The byte grants nothing: each acceptor runs its
// own roster check (a device that dials KK fails the server check, a server that dials IK fails the device check), and
// nothing past the handshake is parsed before it passes.
import { hs1Mode, type SessionTransport } from "../../session";

/** What `/v3/ws` (server/net/ws.ts) and the relay (server/net/relay.ts) need of an accepted session. */
export interface AcceptedSession {
  readonly link: { readonly established: Promise<unknown>; resume?(): void };
  receive(frame: Uint8Array): void;
  transportClosed(): void;
}

export interface DeviceAcceptor { accept(transport: SessionTransport, kind: "tailnet" | "relay"): AcceptedSession }
export interface PeerAcceptor { accept(transport: SessionTransport, kind: "tailnet" | "relay"): AcceptedSession }
/** Server pairing (M3 step 4): a `pair` HS1 naming one of this server's join offers goes here (server/pairing/join.ts). */
export interface JoinAcceptor { isOffer(offerId: string): boolean; accept(transport: SessionTransport, kind: "tailnet" | "relay"): AcceptedSession }

/** The offer id a `pair` HS1 names in the clear (`0x10 ‖ version ‖ mode ‖ transport ‖ e_i ‖ offerLen ‖ offer ‖ …`), or null. */
export function hs1Offer(frame: Uint8Array): string | null {
  if (hs1Mode(frame) !== "pair" || frame.length < 37) return null;
  const length = frame[36]!;
  if (length < 16 || length > 32 || frame.length < 37 + length) return null;
  let text = "";
  for (const byte of frame.subarray(37, 37 + length)) text += String.fromCharCode(byte);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : null;
}

/** A socket that sends no first frame within this time is closed (the acceptors' own handshake timers start later). */
export const FIRST_FRAME_TIMEOUT_MS = 15_000;

export class SessionRouter {
  constructor(private readonly devices: DeviceAcceptor, private readonly peers: PeerAcceptor | null, private readonly firstFrameMs = FIRST_FRAME_TIMEOUT_MS, private readonly joins: JoinAcceptor | null = null) {}

  private pick(frame: Uint8Array, transport: SessionTransport, kind: "tailnet" | "relay"): AcceptedSession {
    const mode = hs1Mode(frame);
    if (mode === "kk" && this.peers) return this.peers.accept(transport, kind);
    if (mode === "pair" && this.joins) {
      const offer = hs1Offer(frame);
      if (offer && this.joins.isOffer(offer)) return this.joins.accept(transport, kind);
    }
    return this.devices.accept(transport, kind);
  }

  accept(transport: SessionTransport, kind: "tailnet" | "relay"): AcceptedSession {
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
      link: { established, resume: () => target?.link.resume?.() },
      receive: (frame) => {
        if (ended) return;
        if (!target) {
          clearTimeout(timer);
          target = this.pick(frame, transport, kind);
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
