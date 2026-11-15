// Settings › Phone in the Botling 3 window (the 2.x renderer's PhoneSettings, its `v3` screen): the window's `mobile.*`
// requests answered by botlingd's own device pairing (service.ts) and relay setting, never by the 2.x core inside it
// (which has no relay and no v3 pairing). They come only as `req`s on this machine's local socket (commands.ts kind
// `local`; session-core.ts sends them here), so nothing they answer is ever stored:
//
//   mobile.view     the cluster's state, the relay (address, connected or not, fixed by BOTLING_SERVER_RELAY_URL), the
//                   pairings this window started and the valid paired phones. Never a link, a secret or a recovery code.
//   mobile.cluster  the first pairing makes the cluster (§4.8): without a code a new recovery code (shown once, never
//                   kept here), with one the code typed back.
//   mobile.pair     a new offer (service.createOffer): the link the window shows as a QR, its expiry, its offer id.
//   mobile.confirm  the person compared the 6-digit code (`pair.code` event) with the phone's: accept adds the phone,
//                   reject burns the offer. Only an offer this window made that waits for exactly that check (L-008); a
//                   second tap while the first is in hand is refused, so one `pair.confirm` goes out (L-007).
//   mobile.revoke   revokes a paired phone (its sessions end at once).
//   mobile.relay    keeps the relay address (relay.json) and switches botlingd's room over now (the relay port).
//
// Offers this window made are followed through the pairing events: waiting → compare (the code and the phone's name)
// → adding → paired, or declined (codes differ, expired, cancelled); an `ack lost` makes the offer wait again (the phone
// retries with the same link). At most 10 are kept, finished ones for 2 minutes.
import { ContractError, type Command, type CommandType, type MobileClusterView, type MobileDeskView, type MobilePairView, type MobileV3View } from "../../contract";
import { AdminOp, parsePairLink, type AdminEvent } from "../../protocol";
import { relayPageOrigin } from "../../session";
import { RelaySettingError } from "../net/relay-setting";
import { PairingError, type DeviceRow, type PairOfferResult } from "./service";

/** The commands this desk answers (all `local` in commands.ts). */
export const PHONE_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  "mobile.view", "mobile.pair", "mobile.revoke", "mobile.relay", "mobile.cluster", "mobile.confirm",
]);

/** What the desk needs of the pairing service (service.ts PairingService has it). */
export interface PhonePairing {
  admin(op: AdminOp): Promise<unknown>;
  onEvent(listener: (event: AdminEvent) => void): () => void;
}

/** botlingd's relay as Settings › Phone shows and changes it. */
export interface PhoneRelay {
  /** The address in use (null: off), whether botlingd's room is connected, and whether the environment fixes it. */
  view(): { url: string | null; state: "off" | "connecting" | "online" | "offline"; fixed: boolean };
  /** Keeps `url` (null: off) and switches over now. Throws RelaySettingError with what to type instead. */
  set(url: string | null): Promise<void>;
}

export interface PhoneDeskOptions {
  pairing: PhonePairing;
  relay: PhoneRelay;
  now?: () => number;
}

type OfferState = MobileV3View["offers"][number];
interface Followed { view: OfferState; at: number; confirming: boolean }

const KEEP_OFFERS = 10;
const KEEP_FINISHED_MS = 2 * 60_000;

export class PhoneDesk {
  private readonly offers = new Map<string, Followed>();
  private readonly now: () => number;
  private readonly stop: () => void;

  constructor(private readonly options: PhoneDeskOptions) {
    this.now = options.now ?? Date.now;
    this.stop = options.pairing.onEvent((event) => this.onEvent(event));
  }

  handles(type: CommandType): boolean { return PHONE_COMMANDS.has(type); }

  close(): void { this.stop(); this.offers.clear(); }

  async run(cmd: Command): Promise<unknown> {
    switch (cmd.type) {
      case "mobile.view": return this.view();
      case "mobile.cluster": return this.cluster(cmd.code);
      case "mobile.pair": return this.pair(cmd);
      case "mobile.confirm": return this.confirm(cmd.offer, cmd.accept);
      case "mobile.revoke": {
        const op = AdminOp.safeParse({ op: "device.revoke", deviceId: cmd.deviceId });
        if (!op.success) throw new ContractError("bad_request", "That is not a paired phone's id.");
        await this.admin(op.data);
        return this.view();
      }
      case "mobile.relay": {
        try { await this.options.relay.set(cmd.url); } catch (error) {
          if (error instanceof RelaySettingError) throw new ContractError("bad_request", error.message);
          throw error;
        }
        return this.view();
      }
      default: throw new ContractError("bad_request", `${cmd.type} is not a phone request.`);
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async view(): Promise<MobileDeskView> {
    const status = await this.admin({ op: "cluster.status" }) as { clusterId: string | null; pending: { expiresAt: number } | null };
    const listed = status.clusterId === null ? [] : ((await this.admin({ op: "devices.list" })) as { devices: DeviceRow[] }).devices;
    const relay = this.options.relay.view();
    this.prune();
    return {
      enabled: false, routes: [], devices: [],
      relay: { url: relay.url, state: relay.state },
      v3: {
        cluster: status.clusterId !== null ? "ready" : status.pending ? "confirming" : "none",
        relayFixed: relay.fixed,
        offers: [...this.offers.values()].sort((a, b) => b.at - a.at).map((entry) => this.shown(entry)),
        devices: listed.filter((row) => row.valid && !row.revoked).slice(0, 400)
          .map((row) => ({ id: row.id, name: row.name.slice(0, 100), addedAt: row.addedAt, scope: row.scope.slice(0, 8) })),
      },
    };
  }

  private async cluster(code: string | undefined): Promise<MobileClusterView> {
    if (code === undefined) {
      const started = await this.admin({ op: "cluster.create" }) as { code: string; expiresAt: number };
      return { ok: true, code: started.code, expiresAt: started.expiresAt };
    }
    const op = AdminOp.safeParse({ op: "cluster.confirm", code });
    if (!op.success) return { ok: false, reason: "malformed" };
    const result = await this.admin(op.data) as { ok: boolean; reason?: string };
    return result.ok ? { ok: true } : { ok: false, reason: String(result.reason ?? "refused").slice(0, 40) };
  }

  private async pair(cmd: Extract<Command, { type: "mobile.pair" }>): Promise<MobilePairView> {
    // A Botling 3 phone gets every bot (its scope, not a bot list): a list cannot be honoured, so it is refused.
    if (cmd.botIds) throw new ContractError("bad_request", "A Botling 3 phone gets every bot; a bot list is not taken.");
    const made = await this.admin({ op: "pair.offer" }) as PairOfferResult;
    const origin = new URL(made.link).origin;
    // The link opens the relay's page when the offer's relay serves it (no tailnet origin): a "relay" route.
    const relay = parsePairLink(made.link)?.addresses.relay?.url ?? null;
    let viaRelay = false;
    try { viaRelay = relay !== null && relayPageOrigin(relay) === origin; } catch { viaRelay = false; }
    this.offers.set(made.offer, { view: { offer: made.offer, state: "waiting", expiresAt: made.expiresAt }, at: this.now(), confirming: false });
    this.prune();
    return {
      url: made.link, expiresAt: made.expiresAt, offer: made.offer,
      route: { kind: viaRelay ? "relay" : "tailscale", origin },
      ...(made.note ? { note: made.note.slice(0, 500) } : {}),
    };
  }

  private async confirm(offer: string, accept: boolean): Promise<MobileDeskView> {
    const entry = this.offers.get(offer);
    if (!entry || entry.confirming || entry.view.state !== "compare" || this.now() >= entry.view.expiresAt) {
      throw new ContractError("conflict", "That pairing is not waiting for a code check any more.");
    }
    const op = AdminOp.safeParse({ op: "pair.confirm", offer, accept });
    if (!op.success) throw new ContractError("bad_request", "That is not a pairing offer.");
    entry.confirming = true;
    let result: { ok: boolean; reason?: string };
    try {
      result = await this.admin(op.data) as { ok: boolean; reason?: string };
    } finally {
      entry.confirming = false;
    }
    // The service may have told the outcome already (pair.declined); only a check still in hand moves on here.
    if (this.offers.get(offer) === entry && entry.view.state === "compare") {
      if (!result.ok) entry.view = { ...this.base(entry), state: "declined", reason: "refused" };
      else if (accept) entry.view = { ...this.base(entry), state: "adding", ...(entry.view.device ? { device: entry.view.device } : {}) };
      else entry.view = { ...this.base(entry), state: "declined", reason: "code" };
      entry.at = this.now();
    }
    if (!result.ok) throw new ContractError("conflict", `The phone was not added (${String(result.reason ?? "refused").slice(0, 100)}).`);
    return this.view();
  }

  private onEvent(event: AdminEvent): void {
    if (!("offer" in event)) return;
    const entry = this.offers.get(event.offer);
    if (!entry) return; // `botlingd pair`'s offers, or one this window no longer follows
    const base = this.base(entry);
    switch (event.kind) {
      case "pair.code": entry.view = { ...base, state: "compare", code: event.code, device: event.deviceName.slice(0, 100) }; break;
      case "pair.done": entry.view = { ...base, state: "paired", ...(entry.view.device ? { device: entry.view.device } : {}) }; break;
      case "pair.declined":
        entry.view = event.reason === "ack lost" ? { ...base, state: "waiting" } : { ...base, state: "declined", reason: event.reason === "code" || event.reason === "expired" ? event.reason : "cancelled" };
        break;
      default: return;
    }
    entry.at = this.now();
  }

  private base(entry: Followed): Pick<OfferState, "offer" | "expiresAt"> {
    return { offer: entry.view.offer, expiresAt: entry.view.expiresAt };
  }

  /** What the window sees of an offer: past its time while still open, it is declined (expired). */
  private shown(entry: Followed): OfferState {
    const open = entry.view.state === "waiting" || entry.view.state === "compare";
    return open && this.now() >= entry.view.expiresAt ? { ...this.base(entry), state: "declined", reason: "expired" } : entry.view;
  }

  /** Finished offers go after 2 minutes; never more than 10 (the oldest first). */
  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.offers) {
      if (entry.confirming) continue;
      // Paired or declined: since that event; still open past its time: since it expired.
      const ended = entry.view.state === "paired" || entry.view.state === "declined" ? entry.at : entry.view.expiresAt;
      if (now - ended > KEEP_FINISHED_MS) this.offers.delete(id);
    }
    const oldest = [...this.offers.entries()].sort((a, b) => a[1].at - b[1].at);
    while (oldest.length > KEEP_OFFERS) this.offers.delete(oldest.shift()![0]);
  }

  /** One admin request; a pairing refusal becomes a contract error with its words (never a secret: no op here has one in its error). */
  private async admin(op: AdminOp): Promise<unknown> {
    try {
      return await this.options.pairing.admin(op);
    } catch (error) {
      if (error instanceof PairingError) throw new ContractError("conflict", error.message);
      if (error instanceof ContractError) throw error;
      throw new ContractError("conflict", String((error as Error)?.message ?? error).slice(0, 500));
    }
  }
}
