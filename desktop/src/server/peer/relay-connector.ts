// How botlingd dials a peer server through the peer's relay room (M4-16b, protocol v1 §6.1, §6.3): joins the
// peer's room with this server's per-peer token (reusing fe-link/relay-socket.ts `relaySocketImpl` with `ws`), carries
// session frames inside `d`, and paces outbound frames at ≤ 45/s (burst ≤ 150, content ≤ 30/s) with SessionLink
// back-pressure (`writable()` / `resume()`).
import { WebSocket as WsWebSocket } from "ws";
import { relaySocketImpl, type RelaySocket } from "../../fe-link";
import { relayDeviceToken, type Lane } from "../../session";
import { RelayPacer, type PaceStats, type RelayPacerOptions } from "../net/pacing";
import type { PeerConnection, PeerConnector } from "./connector";

const JOIN_TIMEOUT_MS = 15_000;
const CHANNEL = "peer";
/** The largest text frame the relay forwards (relay/src/relay.ts MAX_FRAME_BYTES), with room for the JSON wrapper. */
const MAX_TEXT = 4 * 1024 * 1024 - 256;

export interface RelayPeerConnection extends PeerConnection {
  /** Binds the session's frame/close handlers and optional pacer back-pressure resume wake-up. */
  bind(events: { frame(frame: Uint8Array): void; closed(): void; resume?(): void }): void;
  /** Outbound pacer measurements (§6.3: ≤ 45/s, burst ≤ 150, content ≤ 30/s). */
  readonly pace: PaceStats;
  /** The relay's refusal code when it refused the join (`denied`, `desk_offline`, …). */
  readonly refusal: string | null;
}

export interface RelayConnectorBase {
  /** The peer server's room id on the relay (from its Profile `addresses.relay.room`). */
  room: string;
  /** Pacing overrides (defaults to RELAY_PACE: 45/s, burst 150, content 30/s). */
  pace?: Omit<RelayPacerOptions, "write" | "buffered">;
  /** How long the relay may take to admit the join (ms, default 15_000). */
  timeoutMs?: number;
}

export type RelayConnectorOptions =
  | (RelayConnectorBase & {
      /** This server's member id and X25519 private key (to derive the per-peer token). */
      self: { memberId: string; dhKey: CryptoKey };
      /** The peer server's X25519 public key (from its roster Add). */
      peerDhPub: Uint8Array;
    })
  | (RelayConnectorBase & {
      /** Explicit or pre-computed join token. */
      token: string | Promise<string>;
    });

export interface RelayPeerConnector extends PeerConnector {
  connect(url: string): Promise<RelayPeerConnection>;
}

/** Dials a peer server's relay room at `url` (e.g. `ws://…/ws` or `wss://…/ws` from its Profile `addresses.relay`). */
export function relayConnector(
  options: RelayConnectorOptions | ((url: string) => RelayConnectorOptions),
): RelayPeerConnector {
  return {
    connect(url: string): Promise<RelayPeerConnection> {
      const resolved = typeof options === "function" ? options(url) : options;
      // §6.3: the join token is per peer (never the room key), derived identically to the peer room's allow list.
      const token = "token" in resolved
        ? resolved.token
        : relayDeviceToken(resolved.self.memberId, resolved.self.dhKey, resolved.peerDhPub);

      return new Promise((resolve, reject) => {
        const Socket = relaySocketImpl(
          () => ({ url, room: resolved.room, token }),
          WsWebSocket as unknown as typeof WebSocket,
        );
        let socket: RelaySocket;
        try {
          socket = new Socket(url) as unknown as RelaySocket;
        } catch (error) {
          reject(error);
          return;
        }

        const waiting: Uint8Array[] = [];
        const pending: Uint8Array[] = [];
        let bound: { frame(frame: Uint8Array): void; closed(): void; resume?(): void } | null = null;
        let closed = false;
        let settled = false;

        const pacer = new RelayPacer({
          ...resolved.pace,
          write: () => {
            const frame = pending.shift();
            if (!frame || closed || socket.readyState !== 1) return;
            socket.send(frame);
          },
          buffered: () => socket.bufferedAmount,
        });

        const timeoutMs = resolved.timeoutMs ?? JOIN_TIMEOUT_MS;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          closed = true;
          pacer.stop();
          pending.length = 0;
          socket.close();
          reject(new Error("the relay connection did not open in time"));
        }, timeoutMs);
        timer.unref?.();

        const connection: RelayPeerConnection = {
          get pace() { return pacer.stats; },
          get refusal() { return socket.refusal; },
          send: (frame: Uint8Array, lane?: Lane) => {
            if (closed) return;
            // Base64url expands 3 bytes to 4 characters; guard against the relay's 4 MiB frame limit.
            if (Math.ceil(frame.length / 3) * 4 + 16 > MAX_TEXT) {
              connection.close();
              bound?.closed();
              return;
            }
            pending.push(frame.slice());
            pacer.push(CHANNEL, lane === "bulk" ? "bulk" : "control", "");
          },
          writable: () => {
            if (closed) return true;
            const ok = pacer.writable(CHANNEL);
            if (!ok) pacer.onWritable(CHANNEL, () => { if (!closed) bound?.resume?.(); });
            return ok;
          },
          close: () => {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            pacer.stop();
            pending.length = 0;
            socket.close();
          },
          bind: (events) => {
            bound = events;
            for (const frame of waiting.splice(0)) events.frame(frame);
            if (closed) events.closed();
          },
        };

        socket.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(connection);
        };
        socket.onmessage = (event) => {
          if (closed) return;
          if (!(event.data instanceof ArrayBuffer)) {
            connection.close();
            bound?.closed();
            return;
          }
          const frame = new Uint8Array(event.data);
          if (bound) bound.frame(frame); else waiting.push(frame);
        };
        socket.onclose = (event) => {
          clearTimeout(timer);
          closed = true;
          pacer.stop();
          pending.length = 0;
          if (!settled) {
            settled = true;
            const code = event.code ?? 0;
            const why = socket.refusal || event.reason || "";
            reject(new Error(`relay join closed (${code}${why ? `: ${why}` : ""})`));
            return;
          }
          bound?.closed();
        };
        socket.onerror = () => { /* RelaySocket fires onclose on failure or timeout */ };
      });
    },
  };
}
