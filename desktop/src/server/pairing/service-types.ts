// Types of the pairing service (M7-S22, moved unchanged out of service.ts): its options, what a pairing session gives it,
// the answers it returns to `admin` requests, `PairingError` and the offer a session holds.
import type { DeviceScope, Message } from "../../protocol";
import type { ClusterSetup } from "../identity/cluster";
import type { RosterStore } from "../roster/store";
import type { PairSession } from "./service";

export interface PairAddresses { tailnet?: string; relay?: { url: string; room: string } }

export interface PairingOptions {
  roster: RosterStore;
  cluster: ClusterSetup;
  /** This server's public keys (the offer names them). */
  identity: { readonly memberId: string; readonly keys: { readonly sign: string; readonly dh: string } };
  /** How the offer names this server. */
  serverName: string;
  /** Where devices reach this server (the offer must name at least one); read at each offer. */
  addresses: () => PairAddresses;
  /** The page the link opens (`<tailnet origin>/v3/`). */
  pageUrl: () => string;
  /** A note for the person pairing when the address is only a placeholder (no tailnet origin set yet), else null. */
  addressNote?: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
  helloTimeoutMs?: number;
  ackTimeoutMs?: number;
}

/** What a pairing session gives the service: send a pairing message, end the session. */
export interface PairLink {
  send(message: Message): boolean;
  end(): void;
}

/** One established pairing session, as the service drives it. */
export interface PairChannel {
  onMessage(message: Message): void;
  closed(): void;
}

export type PairOfferResult = { offer: string; link: string; expiresAt: number; clusterId: string; note?: string };
export interface DeviceRow { id: string; name: string; scope: string[]; valid: boolean; revoked: boolean; addedAt: number; addedBy: string }
export type MachineRemovePreview =
  | { isRoot: false; rootMember: string; rootName: string }
  | {
      isRoot: true;
      member: string;
      name: string;
      fingerprint: string;
      cascade: Array<{ member: string; kind: "server" | "device"; name: string }>;
    };
export interface DroppedListRow {
  revokeId: string;
  member: string;
  memberName: string;
  memberFingerprint: string;
  signer: string;
  signerName: string;
  gen: number;
  receivedAt: number | null;
  why: "left-out" | "arrived-after";
}
export interface DroppedListResult {
  isRoot: boolean;
  rootMember: string | null;
  rootName: string | null;
  rows: DroppedListRow[];
}
export interface RecoveryStatusResult {
  hasCluster: boolean;
  isRoot: boolean;
  rootMember: string | null;
  rootName: string | null;
  serverName: string;
}

export interface RerootKeepCandidate {
  revokeId: string;
  member: string;
  memberName: string;
  signer: string;
  signerName: string;
  gen: number;
  receivedAt: number | null;
}
export type RerootPreview =
  | { isRoot: true; selfMember: string; selfName: string }
  | {
      isRoot: false;
      selfMember: string;
      selfName: string;
      oldRootMember: string;
      oldRootName: string;
      keepCandidates: RerootKeepCandidate[];
    };
export interface RerootAddedMember {
  member: string;
  kind: "server" | "device";
  name: string;
  at: number;
}
export type RerootResult =
  | {
      ok: true;
      rootId: string;
      revokeId: string | null;
      gen: number;
      oldRootAdded: RerootAddedMember[];
    }
  | { ok: false; reason: "bad-code" };

export class PairingError extends Error {
  constructor(
    readonly code: "no-cluster" | "limit" | "unknown" | "state" | "no-address" | "not-a-device" | "bad-request" | "not-root" | "cannot-revoke-root" | "not-a-server" | "ambiguous" | "bad-code" | "already-root" | "bad-keep" | "self-revoked",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export type OfferState =
  | { kind: "open" }
  | { kind: "hello"; session: PairSession }
  | { kind: "comparing"; session: PairSession }
  | { kind: "adding"; session: PairSession }
  | { kind: "held"; session: PairSession; addId: string };

export interface Offer {
  id: string;
  secret: Uint8Array;
  expiresAt: number;
  scope: DeviceScope[] | undefined;
  /** A name the user gave the device at `pair.offer` (else the device's own). */
  name: string | undefined;
  state: OfferState;
  timer: ReturnType<typeof setTimeout> | null;
}
