// `botlingd pair`, `botlingd devices`, `botlingd revoke-device` (M2 step 5, protocol v1 §4.4, §4.6, §4.8), over the
// running botlingd's local socket (admin-client.ts). Input and output are injected, so tests drive the same code.
//
//   pair [--name <device name>] [--scope read,reply,approve,manage]
//     1. No cluster yet (the first pairing): the recovery code is shown once and must be typed back; the cluster exists
//        only after that (three tries; otherwise nothing is made).
//     2. An offer: the link (its fragment holds the one-time secret) and the same as a QR code, valid 5 minutes.
//     3. A device answers: both screens show a 6-digit code; the user says whether they match.
//     4. The device acknowledges its Add: done. A lost ack gives the offer back (the device may retry until it expires).
//   devices [--json]                  the devices in the roster, valid and revoked
//   revoke-device <id> [--reason …]   revokes a device; its sessions end at once
import type { AdminEvent, DeviceScope } from "../../protocol";
import { AdminRefused, type AdminClient } from "./admin-client";
import { qrTerminal } from "./qr";
import type { DeviceRow, PairOfferResult } from "./service";

export interface CliIo {
  out(line: string): void;
  /** One line typed by the user (null when the input ended). */
  ask(prompt: string): Promise<string | null>;
}

const RECOVERY_TRIES = 3;
const groupCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `botlingd pair`; resolves with the exit code. */
export async function pairCommand(client: AdminClient, io: CliIo, options: { name?: string; scope?: DeviceScope[]; qr?: boolean } = {}): Promise<number> {
  const status = await client.request({ op: "cluster.status" }) as { clusterId: string | null };
  if (status.clusterId === null) {
    const made = await createCluster(client, io);
    if (!made) return 1;
  }
  let offer: PairOfferResult;
  try {
    offer = await client.request({ op: "pair.offer", ...(options.name ? { name: options.name } : {}), ...(options.scope ? { scope: options.scope } : {}) }) as PairOfferResult;
  } catch (error) {
    io.out(`Cannot make a pairing offer: ${errorText(error)}`);
    return 1;
  }
  io.out("Open this link on the phone or browser to pair it (or scan the code below). It works once, for 5 minutes:");
  io.out(offer.link);
  if (options.qr !== false) {
    try { io.out(qrTerminal(offer.link)); } catch { io.out("(the link is too long for a QR code; paste it instead)"); }
  }
  if (offer.note) io.out(`Note: ${offer.note}`);
  io.out(`Waiting for the device (until ${new Date(offer.expiresAt).toLocaleTimeString()})…`);
  for (;;) {
    const left = offer.expiresAt - Date.now() + 2_000;
    const event = await client.nextEvent((e): e is AdminEvent => "offer" in e && e.offer === offer.offer, left);
    if (!event) {
      io.out(client.closed ? "botlingd closed the session." : "The offer expired; run botlingd pair again.");
      if (!client.closed) await client.request({ op: "pair.cancel", offer: offer.offer }).catch(() => undefined);
      return 1;
    }
    if (event.kind === "pair.code") {
      io.out(`A device answers: "${event.deviceName}" (${event.deviceId}).`);
      io.out(`Code: ${groupCode(event.code)}`);
      const answer = await io.ask("Does the device show the same code? [y/N] ");
      const accept = !!answer && /^\s*y(es)?\s*$/i.test(answer);
      const result = await client.request({ op: "pair.confirm", offer: offer.offer, accept }) as { ok: boolean; reason?: string };
      if (!accept) { io.out("Declined: the codes differ, so the offer was cancelled. Run botlingd pair again."); return 1; }
      if (!result.ok) { io.out(`Not added: ${result.reason ?? "refused"}.`); if (result.reason !== "expired") continue; return 1; }
      io.out("Added; waiting for the device to confirm…");
      continue;
    }
    if (event.kind === "pair.done") { io.out(`Paired: ${event.deviceId} (Add ${event.addId}).`); return 0; }
    if (event.kind === "pair.declined") {
      if (event.reason === "ack lost") { io.out("The device did not confirm in time; the offer is open again, so the device can retry with the same link."); continue; }
      io.out(event.reason === "code" ? "Declined on the device: the codes differ. Run botlingd pair again." : `The pairing ended: ${event.reason}.`);
      return 1;
    }
  }
}

/** The first pairing makes the cluster: the recovery code shown once, then typed back. */
async function createCluster(client: AdminClient, io: CliIo): Promise<boolean> {
  const started = await client.request({ op: "cluster.create" }) as { code: string; clusterId: string; expiresAt: number };
  io.out("This is the first pairing, so it creates your Botling cluster.");
  io.out("Your recovery code (shown once; write it down or keep it in a password manager, never in Botling):");
  io.out("");
  io.out(`    ${started.code}`);
  io.out("");
  io.out("It is needed to replace this machine as the cluster's root if it is ever lost. Type it back to confirm.");
  for (let attempt = 1; attempt <= RECOVERY_TRIES; attempt++) {
    const typed = await io.ask("Recovery code: ");
    if (typed === null) break;
    let result: { ok: boolean; reason?: string; clusterId?: string };
    try {
      result = await client.request({ op: "cluster.confirm", code: typed }) as typeof result;
    } catch (error) {
      if (!(error instanceof AdminRefused)) throw error;
      result = { ok: false, reason: "malformed" };
    }
    if (result.ok) { io.out(`Cluster ${result.clusterId} created.`); return true; }
    if (result.reason === "expired" || result.reason === "no-setup") break;
    io.out(result.reason === "malformed" ? "That is not a recovery code (26 letters and digits)." : "That is not the code shown above.");
  }
  io.out("The recovery code was not confirmed, so no cluster was made. Run botlingd pair again for a new code.");
  return false;
}

/** `botlingd devices`. */
export async function devicesCommand(client: AdminClient, io: CliIo, options: { json?: boolean } = {}): Promise<number> {
  const { devices } = await client.request({ op: "devices.list" }) as { devices: DeviceRow[] };
  if (options.json) { io.out(JSON.stringify(devices)); return 0; }
  if (!devices.length) { io.out("No devices are paired."); return 0; }
  for (const device of devices) {
    const state = device.revoked ? "revoked" : device.valid ? "valid" : "not valid";
    io.out(`${device.id}  ${device.name}  ${state}  scope ${device.scope.join("+") || "-"}  added ${new Date(device.addedAt).toISOString()}`);
  }
  return 0;
}

/** `botlingd revoke-device <id>`. */
export async function revokeDeviceCommand(client: AdminClient, io: CliIo, deviceId: string, reason?: string): Promise<number> {
  try {
    const result = await client.request({ op: "device.revoke", deviceId, ...(reason ? { reason } : {}) }) as { revokeId: string; already: boolean };
    io.out(result.already ? `${deviceId} was already revoked.` : `Revoked ${deviceId}; its sessions were closed (Revoke ${result.revokeId}).`);
    return 0;
  } catch (error) {
    io.out(`Cannot revoke ${deviceId}: ${errorText(error)}`);
    return 1;
  }
}
