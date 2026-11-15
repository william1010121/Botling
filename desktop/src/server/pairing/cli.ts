// `botlingd pair`, `botlingd devices`, `botlingd revoke-device`, `botlingd machines remove`, `botlingd reroot` (M2 step 5,
// M4-05, M4-10, M4-11, protocol v1 §4.3–§4.6, §4.8), over the running botlingd's local socket (admin-client.ts).
// Input and output are injected, so tests drive the same code.
//
//   pair [--name <device name>] [--scope read,reply,approve,manage]
//     1. No cluster yet (the first pairing): the recovery code is shown once and must be typed back; the cluster exists
//        only after that (three tries; otherwise nothing is made).
//     2. An offer: the link (its fragment holds the one-time secret) and the same as a QR code, valid 5 minutes.
//     3. A device answers: both screens show a 6-digit code; the user says whether they match.
//     4. The device acknowledges its Add: done. A lost ack gives the offer back (the device may retry until it expires).
//   join [--name <name>]              (on the joining server N, §4.5) prints this server's name, fingerprint, the code to
//                                     type into the member S and the link for S; shows S's fingerprint once it dials;
//                                     ends when S finished the join, or when the offer is declined or expires
//   add-machine [<link>] [--expect-fingerprint <fp>]
//                                     (on the member S; with no argument the link is read from stdin, which keeps its
//                                     secret out of the process list) shows N's fingerprint and needs "yes" that N shows
//                                     the same before it asks for the code; unattended, --expect-fingerprint names it shows both fingerprints, asks for the code shown on N (three
//                                     tries), then adds N; the first pairing creates the cluster first (recovery code)
//   devices [--json]                  the devices in the roster, valid and revoked
//   revoke-device <id> [--reason …]   revokes a device; its sessions end at once
//   machines remove <name-or-id> [--yes | --only]
//                                     (on the revocation root, §4.3) previews what it added, asks once, and revokes it
//   reroot [--keep-all] [--old-root lost|keep]
//                                     (§4.8, M4-11) promotes this server to revocation root; recovery code on stdin only
import { memberFingerprint, parseJoinLink, RecoveryCode, type AdminEvent, type DeviceScope } from "../../protocol";
import { AdminRefused, type AdminClient } from "./admin-client";
import { qrTerminal } from "./qr";
import type { DeviceRow, DroppedListResult, MachineRemovePreview, PairOfferResult, RerootPreview, RerootResult } from "./service";
import type { JoinOfferResult, MachineAddResult, MachineCodeResult } from "./join";

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

/** `botlingd machines remove <name-or-id> [--yes | --only]`. */
export async function removeMachineCommand(
  client: AdminClient,
  io: CliIo,
  target: string,
  options: { yes?: boolean; only?: boolean } = {},
): Promise<number> {
  if (options.yes && options.only) {
    io.out("Cannot use both --yes and --only.");
    return 2;
  }
  let preview: MachineRemovePreview;
  try {
    preview = await client.request({ op: "machine.removePreview", member: target }) as MachineRemovePreview;
  } catch (error) {
    io.out(`Cannot remove ${target}: ${errorText(error)}`);
    return 1;
  }
  if (!preview.isRoot) {
    io.out(`Only the revocation root (${preview.rootName}) can remove a machine. Run this there.`);
    return 1;
  }
  const phones = preview.cascade.filter((item) => item.kind === "device");
  const machines = preview.cascade.filter((item) => item.kind === "server");
  const formatGroup = (items: typeof phones, singular: string, plural: string) => {
    const count = `${items.length} ${items.length === 1 ? singular : plural}`;
    return items.length ? `${count} (${items.map((item) => `"${item.name}"`).join(", ")})` : count;
  };
  io.out(`Remove "${preview.name}" (fingerprint ${preview.fingerprint})?`);
  io.out(`It also removes what it added: ${formatGroup(phones, "phone", "phones")}, ${formatGroup(machines, "machine", "machines")}.`);
  let cascade: boolean;
  if (options.yes) {
    cascade = true;
  } else if (options.only) {
    cascade = false;
  } else {
    const answer = await io.ask(`Type "remove" to remove it and what it added, "only" to remove just ${preview.name}, anything else to stop: `);
    // EOF on stdin (null) or anything other than "remove" / "only" means stop, never remove.
    const choice = answer?.trim().toLowerCase() ?? "";
    if (choice === "remove") cascade = true;
    else if (choice === "only") cascade = false;
    else {
      io.out("Stopped; nothing was removed.");
      return 1;
    }
  }
  let result: { revokeId: string; already: boolean };
  try {
    result = await client.request({ op: "machine.remove", member: preview.member, cascade }) as { revokeId: string; already: boolean };
  } catch (error) {
    io.out(`Cannot remove ${preview.name}: ${errorText(error)}`);
    return 1;
  }
  if (result.already) {
    io.out(`"${preview.name}" (${preview.member}) was already removed.`);
  } else if (cascade) {
    io.out(`Removed "${preview.name}" (${preview.member}) and what it added (Revoke ${result.revokeId}).`);
  } else {
    io.out(`Removed "${preview.name}" (${preview.member}); what it added was kept (Revoke ${result.revokeId}).`);
  }
  return 0;
}

/** `botlingd machines dropped [--json]` (§4.8, M4-10): lists dropped server revocations; offers revoke again or dismiss on the root. */
export async function droppedMachinesCommand(
  client: AdminClient,
  io: CliIo,
  options: { json?: boolean } = {},
): Promise<number> {
  let list: DroppedListResult;
  try {
    list = await client.request({ op: "roster.dropped" }) as DroppedListResult;
  } catch (error) {
    io.out(`Cannot read dropped revocations: ${errorText(error)}`);
    return 1;
  }
  if (options.json) {
    io.out(JSON.stringify(list));
    return 0;
  }
  if (!list.rows.length) {
    io.out("No dropped revocations.");
    return 0;
  }
  io.out("These revocations did not carry over:");
  const whyText = (why: "left-out" | "arrived-after") =>
    why === "left-out" ? "left out by you at the reroot" : "arrived after the reroot";
  const timeText = (at: number | null) => (at !== null ? new Date(at).toISOString() : "unknown time");
  const rootLabel = list.rootName ?? list.rootMember ?? "the new root";

  list.rows.forEach((row, index) => {
    const base = `  ${index + 1}  "${row.memberName}" (${row.memberFingerprint}) — signed by "${row.signerName}" (gen ${row.gen}, ${whyText(row.why)}, ${timeText(row.receivedAt)})`;
    io.out(list.isRoot ? base : `${base} — re-do on ${rootLabel}`);
  });

  if (!list.isRoot) return 0;

  const revokedMembers = new Set<string>();
  for (const row of list.rows) {
    if (revokedMembers.has(row.member)) continue;
    const answer = await io.ask(
      `For "${row.memberName}" (${row.memberFingerprint}): type "revoke" to revoke again, "dismiss" to dismiss (not mine), anything else to skip: `,
    );
    if (answer === null) break;
    const choice = answer.trim().toLowerCase();
    if (choice === "revoke") {
      const code = await removeMachineCommand(client, io, row.member);
      if (code === 0) revokedMembers.add(row.member);
      continue;
    }
    if (choice === "dismiss") {
      try {
        await client.request({ op: "roster.dismiss", revokeId: row.revokeId });
        io.out(`Dismissed "${row.memberName}" (${row.revokeId}); it stays hidden on this machine.`);
      } catch (error) {
        io.out(`Cannot dismiss "${row.memberName}": ${errorText(error)}`);
        return 1;
      }
      continue;
    }
    io.out(`Skipped "${row.memberName}".`);
  }
  return 0;
}

export class RerootArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerootArgsError";
  }
}

export interface RerootOptions {
  keepAll?: boolean;
  oldRoot?: "lost" | "keep";
}

/** Parses `botlingd reroot` flags; refuses positional arguments so a recovery code can never sit in argv / ps. */
export function parseRerootArgs(args: readonly string[]): RerootOptions {
  const options: RerootOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--keep-all") {
      options.keepAll = true;
      continue;
    }
    if (arg === "--old-root") {
      const value = args[i + 1];
      if (value !== "lost" && value !== "keep") {
        throw new RerootArgsError("--old-root takes lost or keep");
      }
      options.oldRoot = value;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      const flagName = arg.split("=")[0];
      throw new RerootArgsError(`unknown option "${flagName}" (use --keep-all, --old-root lost|keep)`);
    }
    throw new RerootArgsError("reroot reads the recovery code from stdin only, never as an argument");
  }
  return options;
}

const CODE_PROMPT = "Type the recovery code (26 characters; spaces and dashes are fine): ";

/** `botlingd reroot [--keep-all] [--old-root lost|keep]` (§4.8, M4-11): code read from stdin only, never echoed. */
export async function rerootCommand(
  client: AdminClient,
  io: CliIo,
  options: RerootOptions = {},
): Promise<number> {
  let preview: RerootPreview;
  try {
    preview = await client.request({ op: "roster.rerootPreview" }) as RerootPreview;
  } catch (error) {
    io.out(`Cannot reroot: ${errorText(error)}`);
    return 1;
  }
  if (preview.isRoot) {
    io.out(`"${preview.selfName}" is already the revocation root.`);
    return 1;
  }

  io.out(`This makes "${preview.selfName}" the revocation root of your machines.`);
  const firstCode = await io.ask(CODE_PROMPT);
  if (firstCode === null) {
    io.out("Nothing was changed.");
    return 1;
  }

  let oldRootLost: boolean;
  if (options.oldRoot !== undefined) {
    oldRootLost = options.oldRoot === "lost";
  } else {
    const lostAnswer = await io.ask(
      `Is the old root "${preview.oldRootName}" lost or stolen? Type "lost" to remove it (what it added stays), or "keep" to leave it a member: `,
    );
    const choice = lostAnswer?.trim().toLowerCase() ?? "";
    if (choice === "lost") oldRootLost = true;
    else if (choice === "keep") oldRootLost = false;
    else {
      io.out("Stopped; nothing was changed.");
      return 1;
    }
  }

  let keep: string[];
  if (preview.keepCandidates.length === 0 || options.keepAll) {
    keep = preview.keepCandidates.map((c) => c.revokeId);
  } else {
    io.out("Removals made by earlier roots (untick any you did not make):");
    const nameWidth = Math.max(12, ...preview.keepCandidates.map((c) => c.memberName.length + 2)) + 3;
    preview.keepCandidates.forEach((c, index) => {
      const when = c.receivedAt !== null
        ? new Date(c.receivedAt).toISOString().slice(0, 16).replace("T", " ")
        : "unknown time";
      const memberLabel = `"${c.memberName}"`.padEnd(nameWidth);
      io.out(`  [x] ${index + 1}  ${memberLabel}removed by ${c.signerName}   ${when}`);
    });
    const untickAnswer = await io.ask('Type the numbers to UNtick (e.g. "2"), or press Enter to keep all: ');
    if (untickAnswer === null) {
      io.out("Stopped; nothing was changed.");
      return 1;
    }
    const untick = new Set<number>();
    const trimmed = untickAnswer.trim();
    if (trimmed) {
      for (const token of trimmed.split(/[\s,]+/)) {
        if (!/^[0-9]+$/.test(token)) {
          io.out("Invalid selection; nothing was changed.");
          return 1;
        }
        const n = Number(token);
        if (n < 1 || n > preview.keepCandidates.length) {
          io.out("Invalid selection; nothing was changed.");
          return 1;
        }
        untick.add(n - 1);
      }
    }
    keep = preview.keepCandidates.filter((_, index) => !untick.has(index)).map((c) => c.revokeId);
  }

  let candidateCode = firstCode;
  for (let wrongTries = 0;;) {
    let result: RerootResult;
    const parsedCode = RecoveryCode.safeParse(candidateCode);
    if (!parsedCode.success) {
      result = { ok: false, reason: "bad-code" };
    } else {
      try {
        result = await client.request({
          op: "roster.reroot",
          code: parsedCode.data,
          oldRootLost,
          keep,
        }) as RerootResult;
      } catch (error) {
        io.out(`Cannot reroot: ${errorText(error)}`);
        return 1;
      }
    }

    if (result.ok) {
      if (oldRootLost) {
        io.out(`Done. "${preview.selfName}" is the revocation root. "${preview.oldRootName}" was removed; what it added stays.`);
        if (result.oldRootAdded.length > 0) {
          io.out(`Machines and phones "${preview.oldRootName}" added, newest first (remove any you do not know with "botlingd machines remove"):`);
          const labels = result.oldRootAdded.map((item) =>
            item.kind === "device" ? `phone "${item.name}"` : `"${item.name}"`,
          );
          const width = Math.max(16, ...labels.map((label) => label.length + 3));
          result.oldRootAdded.forEach((item, index) => {
            const day = new Date(item.at).toISOString().slice(0, 10);
            io.out(`  ${labels[index]!.padEnd(width)}${day}`);
          });
        }
      } else {
        io.out(`Done. "${preview.selfName}" is the revocation root. "${preview.oldRootName}" remains a member.`);
      }
      io.out('Replace the recovery code now? Run "botlingd recovery replace".');
      return 0;
    }

    wrongTries++;
    io.out("That is not the recovery code. Nothing was changed.");
    if (wrongTries >= RECOVERY_TRIES) return 1;
    const retry = await io.ask(CODE_PROMPT);
    if (retry === null) return 1;
    candidateCode = retry;
  }
}

const JOIN_TRIES = 3;

/** A fingerprint as typed or shown (`ABCD EFGH …`, any case or spacing) to the member id it spells, or null. */
function fingerprintKey(text: string): string | null {
  const key = text.replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z2-7]{26}$/.test(key) ? key : null;
}

/** `botlingd join` on the server that joins (N); resolves with the exit code. */
export async function joinCommand(client: AdminClient, io: CliIo, options: { name?: string } = {}): Promise<number> {
  let offer: JoinOfferResult;
  try {
    offer = await client.request({ op: "join.offer", ...(options.name ? { name: options.name } : {}) }) as JoinOfferResult;
  } catch (error) {
    io.out(`Cannot make a join offer: ${errorText(error)}`);
    return 1;
  }
  io.out(`This machine: ${offer.name}`);
  io.out(`Fingerprint:  ${offer.fingerprint}`);
  io.out(`Code:         ${offer.code}`);
  io.out("On a machine of your cluster, run botlingd add-machine and paste this link when it asks. Say yes there only if it");
  io.out("shows the fingerprint above, then type the code above.");
  io.out(`It works once, for 5 minutes (until ${new Date(offer.expiresAt).toLocaleTimeString()}):`);
  io.out(offer.link);
  for (;;) {
    const left = offer.expiresAt - Date.now() + 2_000;
    const event = await client.nextEvent((e): e is AdminEvent => "offer" in e && e.offer === offer.offer, Math.max(1_000, left));
    if (!event) {
      io.out(client.closed ? "botlingd closed the session." : "The offer expired; run botlingd join again.");
      if (!client.closed) await client.request({ op: "join.cancel", offer: offer.offer }).catch(() => undefined);
      return 1;
    }
    if (event.kind === "join.hello") { io.out(`Server "${event.name}" opened the pairing. Its fingerprint: ${event.fingerprint}`); continue; }
    if (event.kind === "join.wrong") { io.out(event.left ? `A wrong code was typed there (${event.left} ${event.left === 1 ? "try" : "tries"} left).` : "A wrong code was typed there for the third time."); continue; }
    if (event.kind === "join.done") { io.out(`Joined cluster ${event.cluster} through ${event.server}.`); return 0; }
    if (event.kind === "join.declined") {
      io.out(event.reason === "code" ? "Declined: three wrong codes. Run botlingd join again for a new code."
        : event.reason === "member" ? "Declined: this server already belongs to a cluster."
          : `The join ended: ${event.reason}.`);
      return 1;
    }
  }
}

/**
 * `botlingd add-machine [<link>] [--expect-fingerprint <fp>]` on a member (S); resolves with the exit code. With no link argument the link is read
 * from stdin, so its one-time secret is not on the command line, where other local users see it in the process list
 * and the shell keeps it in its history (review J2).
 */
export async function addMachineCommand(client: AdminClient, io: CliIo, linkArg: string | undefined, options: { expectFingerprint?: string } = {}): Promise<number> {
  let link = linkArg?.trim() ?? "";
  if (!link) {
    const typed = await io.ask("Paste the link botlingd join printed on the other machine: ");
    link = typed?.trim() ?? "";
    if (!link) { io.out("No link given; nothing was done."); return 1; }
  }
  // Review R1 (interim): the typed code proves this server to the other one, never the other way round; a link swapped on
  // its way here would get an Add, the roster and the cluster's VAPID key for any code. So N's fingerprint is confirmed
  // first: with `--expect-fingerprint` against the link before anything is dialled (and again against the server's
  // answer), else by the user typing "yes".
  let expected: string | null = null;
  if (options.expectFingerprint !== undefined) {
    expected = fingerprintKey(options.expectFingerprint);
    if (!expected) { io.out("--expect-fingerprint is not a fingerprint (26 letters and digits, as botlingd join prints it); nothing was done."); return 1; }
    const offer = parseJoinLink(link);
    if (offer && fingerprintKey(memberFingerprint(offer.server)) !== expected) {
      io.out(`The link is for fingerprint ${memberFingerprint(offer.server)}, not the expected one; nothing was dialled.`);
      return 1;
    }
  }
  const status = await client.request({ op: "cluster.status" }) as { clusterId: string | null };
  if (status.clusterId === null) {
    const made = await createCluster(client, io);
    if (!made) return 1;
  }
  let added: MachineAddResult;
  try {
    added = await client.request({ op: "machine.add", link }) as MachineAddResult;
  } catch (error) {
    io.out(`Cannot pair that machine: ${errorText(error)}`);
    return 1;
  }
  io.out(`This machine's fingerprint:  ${added.self.fingerprint}`);
  io.out(`"${added.name}" fingerprint: ${added.fingerprint}`);
  if (expected) {
    if (fingerprintKey(added.fingerprint) !== expected) {
      await client.request({ op: "machine.cancel", attempt: added.attempt }).catch(() => undefined);
      io.out(`"${added.name}" has fingerprint ${added.fingerprint}, not the expected one; cancelled, nothing was added.`);
      return 1;
    }
    io.out(`"${added.name}" has the expected fingerprint.`);
  } else {
    const answer = await io.ask(`Does "${added.name}" show exactly this fingerprint for itself: ${added.fingerprint}? Type yes if it does: `);
    if (answer?.trim().toLowerCase() !== "yes") {
      await client.request({ op: "machine.cancel", attempt: added.attempt }).catch(() => undefined);
      io.out(`Not confirmed; cancelled, nothing was added. If "${added.name}" shows another fingerprint, the link is not the one it printed.`);
      return 1;
    }
  }
  io.out(`"${added.name}" should show this machine's fingerprint above as the one that opened the pairing.`);
  for (let typedCount = 0; typedCount < JOIN_TRIES * 2;) {
    const typed = await io.ask(`Code shown on "${added.name}": `);
    if (typed === null) { await client.request({ op: "machine.cancel", attempt: added.attempt }).catch(() => undefined); io.out("No code typed; cancelled."); return 1; }
    let result: MachineCodeResult;
    try {
      result = await client.request({ op: "machine.code", attempt: added.attempt, code: typed.slice(0, 32) || "-" }, 120_000) as MachineCodeResult;
    } catch (error) {
      io.out(`The pairing failed: ${errorText(error)}`);
      return 1;
    }
    if (result.ok) { io.out(`Added "${result.name}" (${result.server}) to cluster ${result.cluster}.`); return 0; }
    if (result.reason === "malformed") { typedCount++; io.out("That is not a code (8 letters and digits, like 53RV-XFK8)."); continue; }
    if (result.reason === "wrong") { typedCount++; io.out(`That is not the code shown there (${result.left} ${result.left === 1 ? "try" : "tries"} left).`); continue; }
    io.out(result.reason === "code" ? "Declined: three wrong codes. Run botlingd join on the other machine again."
      : result.reason === "member" ? "Declined: that machine already belongs to a cluster."
        : `The pairing ended: ${result.reason}${result.detail ? ` (${result.detail})` : ""}.`);
    return 1;
  }
  return 1;
}
