// M7-11b (P7 stand-in): one outcome per outbox item across plugin swaps. The TLA+ `Routing` P7 extension is not in `spec/` yet
// (M7-11c), so this property test stands in for it: seeded random runs of plugin swaps (rows of the attached server's own table
// changing, fetches held, failing and released) interleaved with outbox writes, session cuts, dropped replies, a restore, cancels and
// re-sends, on the REAL pieces: `FeLink` + `Outbox` (src/fe-link) against the fake botlingd of fe-link-harness.ts (the real
// `SlotEngine` over an in-memory server.db), the REAL `RowLoader` (renderer/shell/row-loader.ts) on a real `Kernel`, joined the way the
// page joins them: `followRows` (rows -> swaps) and `followOutcomes` (outcomes -> `RowLoader.route`, M7-09b FU-4). No window, no focus.
//
// The oracle is written from the rules (protocol v1 §11, plan-change D53/D56/D64/D65, the 09b card), not from the code under test:
//   1. One outcome. Every submitted item gets an outcome once the link is quiet (a later outcome event of the same item may only
//      add "then lost", D50: same outcome, `lost: true`, a delivered item only); all events of an item carry the same outcome.
//   2. At most once applied. The owner's apply step runs at most once per item, across any number of re-sends and cuts; it ran
//      exactly when the outcome is `applied` or a refusal of the apply step, never for `cancelled`. Every copy of an item that reaches the
//      owner has the same slot and the same `via` (a swap never rewrites it).
//   3. One placement. An item that names a plugin (`via`) is placed once: on that plugin's live instance when it has one (its outcome
//      sink is attached and its instance is active at the moment of the first outcome), else in the shell's pending view. Later outcome
//      events of the item (the "then lost" one) change nothing (`duplicate`). The placed item still names the code it was written under.
//      An item with no `via` has no plugin to place it on (`none`). Nothing is placed on another plugin's sink, nothing before an outcome.
//   4. A row's end state. Once the link is quiet and the rows are caught, a plugin whose last row names a web part that can be had runs
//      exactly that code; a plugin whose row is gone, or has no web part, runs nothing.
//
// Replay: SWAP_OUTBOX_SEED=<seed> runs one seed alone; SWAP_OUTBOX_RUNS=<n> sets the run count (default 2,000 on the Mac, 10,000 on the Linux
// host and CI: never raise the Mac's).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../../../Web/src/plugin-kernel";
import type { Command } from "../../src/contract";
import { FeLink, MemoryFeStorage, type Dial, type FeLinkEvent } from "../../src/fe-link";
import { slotKey, type Via } from "../../src/protocol";
import { deleteRow, ownTableStream, putRow } from "../../src/server/replica/tables";
import { SlotRefusal } from "../../src/server/slots";
import {
  RowLoader, followOutcomes, followRows, webInstance,
  type BundleFetcher, type OutcomeItem, type OutcomePlace, type RowsLink,
} from "../../src/renderer/shell/row-loader";
import { deferred, seeded } from "../kernel-driver";
import { envCount } from "../helpers";
import { BOT, FakeClock, FakeServer, SRV_STREAM, flush, react } from "./fe-link-harness";

const RUNS = envCount("SWAP_OUTBOX_RUNS", process.platform === "darwin" && !process.env.CI ? 2_000 : 10_000);
const FIRST_SEED = 20_261_116;
const ONE = Number(process.env.SWAP_OUTBOX_SEED ?? "") || null;
const seeds = () => (ONE ? [ONE] : Array.from({ length: RUNS }, (_, index) => FIRST_SEED + index));
// Review M7-11b: a second range with late resets (`holdResets`), a fifth of the runs. Replay one of them: SWAP_OUTBOX_SEED=<seed> SWAP_OUTBOX_HOLD=1.
const HOLD_FIRST_SEED = 30_261_116;
const HOLD = process.env.SWAP_OUTBOX_HOLD === "1";
const holdSeeds = () => (ONE ? (HOLD ? [ONE] : []) : Array.from({ length: Math.max(1, Math.round(RUNS / 5)) }, (_, index) => HOLD_FIRST_SEED + index));
// Re-check 2 M7-11b: a third range, late resets plus a lossy wire (a `cmd` lost with its connection mid-flight, a `cmd.retry` delivered
// late on its own session) and more restores. Replay one of them: SWAP_OUTBOX_SEED=<seed> SWAP_OUTBOX_LOSSY=1.
const LOSSY_FIRST_SEED = 40_261_116;
const LOSSY = process.env.SWAP_OUTBOX_LOSSY === "1";
const lossySeeds = () => (ONE ? (LOSSY ? [ONE] : []) : Array.from({ length: Math.max(1, Math.round(RUNS / 5)) }, (_, index) => LOSSY_FIRST_SEED + index));

// ---------------------------------------------------------------------------------------------------------------------
// The plugins and their versions. A version is a row: a code hash and (usually) a web part the fetcher can return.

const PLUGINS = ["a", "b", "c"] as const;
const GHOST = "ghost"; // a plugin no row ever names: its items have no live instance, ever
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

interface Version { codeHash: string; text: string | null; ref: string | null }
const VERSIONS: Record<string, Version[]> = Object.fromEntries(PLUGINS.map((plugin) => [plugin, [1, 2, 3, 4].map((n): Version => {
  // Version 4 has no web part (a row with no `files.web`: `plugins.web` is its source, nothing to run here).
  const text = n === 4 ? null : `plugin ${plugin} version ${n}`;
  return { codeHash: sha(`code ${plugin} ${n}`), text, ref: text === null ? null : `sha256:${sha(text)}` };
})]));
const TEXT_OF = new Map<string, string>(Object.values(VERSIONS).flat().filter((v) => v.ref).map((v) => [v.ref!, v.text!]));
const ALL_REFS = [...TEXT_OF.keys()];

const EMPTY_MANIFEST = { tier: "read", reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
// A plugin row as the owner keeps it: every version of the plugin has a grant to send `chat.react` (so an item written under an older
// version is still decided by the owner under the table it has now, D53), a plugin with no row has none (`refused{grant}`).
const rowBody = (plugin: string, version: Version) => ({
  codeHash: version.codeHash, manifest: EMPTY_MANIFEST, author: "user",
  grants: Object.fromEntries(VERSIONS[plugin]!.map((v) => [v.codeHash, { tier: "write", reads: [], requests: ["chat.react"], grantedBy: "user", at: 1 }])),
  ...(version.ref ? { files: { web: version.ref } } : {}),
});

// ---------------------------------------------------------------------------------------------------------------------
// One run.

interface Seen { outcome: unknown; state: string; lost: boolean }
interface Message {
  id: string;
  via: Via | undefined;
  refuse: boolean;
  events: Seen[];
  /** What the first outcome event should be placed as, from the state at that moment. */
  expected: OutcomePlace | null;
  places: OutcomePlace[];
}

const links: FeLink[] = [];
afterEach(async () => { for (const link of links.splice(0)) await link.stop(); });

let epochSeq = 0;
const nextEpoch = () => (++epochSeq).toString(16).padStart(32, "0");

interface RunResult { violations: string[]; messages: number; swaps: number; cuts: number; restores: number; lostEvents: number; instance: number; pending: number; none: number }

// `holdResets` (review M7-11b): a restore the front end hears of late (the owner's reset is held until a "release" step or the quiet
// phase), so a `cmd.retry` can arrive while the front end is still on the old inc. Off for the first seed range (its seeds stay as found).
// `lossy` (re-check 2): implies `holdResets`; see LOSSY_FIRST_SEED. Held retries are lost with their session (they never reach a new one).
async function oneRun(seed: number, holdResets = false, lossy = false): Promise<RunResult> {
  const rand = seeded(seed);
  const violations: string[] = [];
  const trace: string[] = []; // the run's steps, for a failure message
  const check = (ok: boolean, text: string) => { if (!ok && violations.length < 12) violations.push(text); };

  // ---- the fake owner
  const server = new FakeServer();
  const applyCalls = new Map<string, number>();
  const messages = new Map<string, Message>();
  server.applyHook = (context) => {
    const id = (context.cmd as { messageId: string }).messageId;
    applyCalls.set(id, (applyCalls.get(id) ?? 0) + 1);
    if (messages.get(id)?.refuse) throw new SlotRefusal("invalid", "refused by the test");
    return { result: { n: context.slot.n } };
  };

  // ---- the link, the kernel and the loader (the page's own wiring)
  const clock = new FakeClock();
  let dropNextCmd = false, delayRetries = 0;
  let heldRetries: Array<() => void> = [];
  const releaseRetries = () => { for (const deliver of heldRetries.splice(0)) deliver(); }; // a closed session's handler ignores it (link.ts)
  const kindOf = (frame: string | Uint8Array) => { try { return typeof frame === "string" ? (JSON.parse(frame) as { t?: string }).t : undefined; } catch { return undefined; } };
  const dial: Dial = !lossy ? server.dial : (handlers) => {
    const inner = server.dial({
      ...handlers,
      frame: (frame) => {
        if (delayRetries > 0 && kindOf(frame) === "cmd.retry") { delayRetries -= 1; heldRetries.push(() => handlers.frame(frame)); return; }
        handlers.frame(frame);
      },
      close: (detail) => { heldRetries = []; handlers.close(detail); },
    });
    return {
      send(frame) {
        if (dropNextCmd && kindOf(frame) === "cmd") { dropNextCmd = false; server.kill(); return; } // lost with the connection
        inner.send(frame);
      },
      close() { inner.close(); },
    };
  };
  const link = await FeLink.open({ storage: new MemoryFeStorage(), dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, local: true });
  links.push(link);

  const kernel = new Kernel({ log: false });
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const failing = new Set<string>(ALL_REFS.filter(() => rand.chance(0.12)));
  const fetch: BundleFetcher = async ({ ref }) => {
    const gate = gates.get(ref);
    if (gate) await gate.promise;
    const text = TEXT_OF.get(ref);
    if (text === undefined || failing.has(ref)) throw new Error("gone");
    return text;
  };
  const shown: Array<{ plugin: string; item: OutcomeItem }> = [];
  const pendingView: OutcomeItem[] = [];
  const loader = new RowLoader({ kernel, fetch, manifest: { plugins: [] }, log: () => undefined, pending: (item) => pendingView.push(item) });
  const attached = new Map<string, () => void>();
  const attach = (plugin: string) => {
    attached.get(plugin)?.();
    attached.set(plugin, loader.attach(plugin, (item) => shown.push({ plugin, item })));
  };
  const detach = (plugin: string) => { attached.get(plugin)?.(); attached.delete(plugin); };

  // The place of each route call (what `followOutcomes` ignores), and the state at the moment of each item's first outcome.
  const route = loader.route.bind(loader);
  loader.route = (item) => {
    const place = route(item);
    const message = messages.get((item as unknown as { cmd: { messageId: string } }).cmd.messageId);
    if (message) message.places.push(place);
    return place;
  };

  const ownStream = ownTableStream(server.db);
  const table = new Map<string, number>(); // plugin -> version index, absent: no row
  let rev = 0;
  const sendTable = () => {
    const first = rev + 1;
    rev += Math.max(1, table.size);
    // Revs rise within a frame and stay above the previous frame's `to`.
    const rows = [...table].map(([plugin, index], at) => ({ key: `plugin:${plugin}`, rev: first + at, body: rowBody(plugin, VERSIONS[plugin]![index]!) }));
    server.sendWire({ t: "rows", stream: SRV_STREAM, logId: "incown01", after: 0, to: rev, rows, more: false });
  };

  let lostEvents = 0;
  // Registered first: runs (synchronously, in the same emit) just before `followOutcomes` routes the same event.
  const linkLog: string[] = []; // state changes, session ends and errors, for a failure message
  link.on((event: FeLinkEvent) => {
    if (event.type === "state") linkLog.push(`${clock.now() - 1_000_000}:${event.status.state}`);
    else if (event.type === "attached") linkLog.push(`${clock.now() - 1_000_000}:attached=${event.attached}`);
    else if (event.type === "bye") linkLog.push(`${clock.now() - 1_000_000}:bye ${event.reason}`);
    else if (event.type === "error") linkLog.push(`${clock.now() - 1_000_000}:error ${String((event.error as Error)?.message ?? event.error).slice(0, 80)}`);
    if (event.type === "attached" && event.attached) sendTable(); // the server sends the whole own table after a (re-)sub
    if (event.type !== "outcome") return;
    const id = (event.item.cmd as { messageId: string }).messageId;
    const message = messages.get(id);
    if (!message) { check(false, `an outcome for an item nobody submitted (${id})`); return; }
    message.events.push({ outcome: event.item.outcome, state: event.item.state, lost: event.item.lost === true });
    if (event.item.lost) lostEvents += 1;
    if (message.events.length === 1) {
      const plugin = message.via?.plugin;
      message.expected = !plugin ? "none" : kernel.state(webInstance(plugin)) === "active" && attached.has(plugin) ? "instance" : "pending";
    }
  });
  const offRows = followRows(loader, link as unknown as RowsLink);
  const offOutcomes = followOutcomes(loader, link);
  link.subscribe(BOT);
  link.start();
  await flush();

  // ---- the random run
  const pool = [...PLUGINS, GHOST];
  let swaps = 0, cuts = 0, restores = 0, count = 0;
  const submits: Array<Promise<unknown>> = [];
  const steps = 14 + rand.int(26);
  for (let step = 0; step < steps; step += 1) {
    let roll = rand.next();
    if (lossy && roll >= 0.95) roll = 0.88; // more restores: a second restore before the first reset is heard
    if (lossy && roll >= 0.78 && roll < 0.83) {
      const pick = rand.int(3);
      if (pick > 0) { trace.push(pick === 1 ? "lose-cmd" : "delay-retry"); if (pick === 1) dropNextCmd = true; else delayRetries += 1; await flush(); continue; }
    }
    trace.push(roll < 0.34 ? "submit" : roll < 0.56 ? "swap" : roll < 0.64 ? "gate" : roll < 0.70 ? "sinks" : roll < 0.78 ? "cut" : roll < 0.83 ? "drop" : roll < 0.87 ? "cancel" : roll < 0.90 ? "restore" : roll < 0.95 ? "release" : "time");
    if (roll < 0.34) {
      // An outbox write by a plugin's code: the `via` names the plugin and the code hash it was written under (the current row's, an
      // older version's, or none: a command of the shell's own).
      const id = `m${count++}`;
      const plugin = rand.pick(pool);
      const hashes = plugin === GHOST ? [sha("ghost code")] : VERSIONS[plugin]!.map((v) => v.codeHash);
      const via: Via | undefined = rand.chance(0.12) ? undefined : { plugin, codeHash: rand.pick(hashes) };
      messages.set(id, { id, via, refuse: rand.chance(0.15), events: [], expected: null, places: [] });
      const write = link.submit(BOT, react(id) as Command, undefined, via);
      if (rand.chance(0.5)) await write; else submits.push(write);
    } else if (roll < 0.56) {
      // A row change: a new version, no web part, or the row gone.
      const plugin = rand.pick(PLUGINS);
      const next = rand.int(6);
      if (next >= VERSIONS[plugin]!.length) { table.delete(plugin); deleteRow(server.db, ownStream, `plugin:${plugin}`, clock.now()); }
      else { table.set(plugin, next); putRow(server.db, ownStream, `plugin:${plugin}`, rowBody(plugin, VERSIONS[plugin]![next]!)); }
      swaps += 1;
      sendTable();
    } else if (roll < 0.64) {
      const ref = rand.pick(ALL_REFS);
      if (gates.has(ref)) { gates.get(ref)!.resolve(); gates.delete(ref); } else gates.set(ref, deferred<void>());
    } else if (roll < 0.70) {
      for (const plugin of PLUGINS) if (rand.chance(0.5)) { if (attached.has(plugin)) detach(plugin); else attach(plugin); }
      if (rand.chance(0.3)) attach(GHOST);
    } else if (roll < 0.78) {
      cuts += 1;
      server.kill();
      if (rand.chance(0.7)) { clock.advance(300 + rand.int(2000)); }
    } else if (roll < 0.83) {
      server.dropReplies = 1 + rand.int(3);
    } else if (roll < 0.87) {
      const waiting = link.pending().filter((view) => view.state === "waiting" || view.state === "held");
      if (waiting.length) await link.cancel(rand.pick(waiting).slot);
    } else if (roll < 0.90) {
      restores += 1;
      if (holdResets) server.holdResets = true;
      server.restore(rand.chance(0.5) ? 0 : undefined);
    } else if (roll < 0.95) {
      for (const [ref] of gates) if (rand.chance(0.5)) { gates.get(ref)!.resolve(); gates.delete(ref); }
      if (holdResets) { server.holdResets = false; server.releaseResets(); }
      if (lossy) { await flush(); releaseRetries(); }
    } else {
      clock.advance(rand.int(8000));
    }
    await flush();
    if (rand.chance(0.4)) { clock.advance(rand.int(700)); await flush(); }
  }
  await Promise.all(submits);

  // ---- quiet: the link reconnects, the held fetches are released, every item gets its outcome
  const quiet = async () => {
    for (let round = 0; round < 80; round += 1) {
      for (const [ref, gate] of gates) { gate.resolve(); gates.delete(ref); }
      server.holdResets = false;
      server.releaseResets();
      dropNextCmd = false;
      delayRetries = 0;
      await flush();
      releaseRetries();
      clock.advance(6_000);
      await flush();
      if ([...messages.values()].every((message) => message.events.length > 0) && link.state === "live") break;
    }
  };
  await quiet();
  if (link.state === "live") sendTable(); // the rows are caught
  await quiet();
  await flush();
  await link.idle();
  await flush();

  // ---- the properties
  let instance = 0, pending = 0, none = 0;
  for (const message of messages.values()) {
    const { id, via } = message;
    const name = `${id}${via ? ` via ${via.plugin}@${via.codeHash.slice(0, 6)}` : ""}`;
    // 1. one outcome
    check(message.events.length > 0, `${name}: no outcome after the link was quiet`);
    const first = message.events[0];
    if (first) {
      check(first.state === "delivered" || first.state === "not sent", `${name}: the first outcome event is not a resolution (${first.state})`);
      check(!first.lost, `${name}: the first outcome event is already "lost"`);
      for (const [index, seen] of message.events.entries()) {
        check(JSON.stringify(seen.outcome) === JSON.stringify(first.outcome), `${name}: outcome event ${index} says ${JSON.stringify(seen.outcome)}, the first said ${JSON.stringify(first.outcome)}`);
        if (index > 0) check(seen.lost && seen.state === "delivered", `${name}: outcome event ${index} is a second outcome (state ${seen.state}, lost ${seen.lost}), not "delivered, then lost"`);
      }
      check(message.events.filter((seen) => !seen.lost).length === 1, `${name}: ${message.events.filter((seen) => !seen.lost).length} outcomes that are not "lost" marks`);
    }
    // 2. at most once applied
    const calls = applyCalls.get(id) ?? 0;
    check(calls <= 1, `${name}: the apply step ran ${calls} times`);
    const kind = (first?.outcome as { kind?: string } | undefined)?.kind;
    if (kind === "applied") check(calls === 1 && !message.refuse, `${name}: outcome applied, apply ran ${calls} times (refuse ${message.refuse})`);
    if (kind === "cancelled") check(calls === 0, `${name}: outcome cancelled, but the apply step ran ${calls} times`);
    if (kind === "refused") {
      // `grant`: the owner's table had no grant for the item's code when it decided: nothing ran. Else the apply step refused it.
      const grant = (first?.outcome as { reason?: string }).reason === "grant";
      check(grant ? calls === 0 && !!via : calls === 1 && message.refuse, `${name}: outcome ${JSON.stringify(first?.outcome)}, apply ran ${calls} times (refuse ${message.refuse})`);
    }
    const copies = server.copies.filter((body) => (body.cmd as { messageId?: string }).messageId === id);
    for (const copy of copies) {
      check(slotKey(copy.slot) === slotKey(copies[0]!.slot), `${name}: a copy came with another slot`);
      check(JSON.stringify(copy.via ?? null) === JSON.stringify(via ?? null), `${name}: a copy came with via ${JSON.stringify(copy.via)} (written with ${JSON.stringify(via)})`);
    }
    // 3. one placement
    if (!via) {
      check(message.places.every((place) => place === "none"), `${name}: no via, placed ${message.places.join(",")}`);
      none += 1;
    } else if (first) {
      check(message.places.length === message.events.length, `${name}: ${message.events.length} outcome events, ${message.places.length} route calls`);
      check(message.places[0] === message.expected, `${name}: placed ${message.places[0]}, expected ${message.expected} (state at its outcome)`);
      check(message.places.slice(1).every((place) => place === "duplicate"), `${name}: a later outcome was placed again (${message.places.join(",")})`);
      const onSinks = shown.filter((entry) => (entry.item as unknown as { cmd: { messageId: string } }).cmd.messageId === id);
      const inPending = pendingView.filter((item) => (item as unknown as { cmd: { messageId: string } }).cmd.messageId === id);
      check(onSinks.length + inPending.length === 1, `${name}: placed ${onSinks.length} times on sinks and ${inPending.length} in the pending view`);
      if (message.expected === "instance") { check(onSinks.length === 1 && onSinks[0]!.plugin === via.plugin, `${name}: not on the sink of ${via.plugin}`); instance += 1; }
      if (message.expected === "pending") { check(inPending.length === 1, `${name}: not in the pending view`); pending += 1; }
      for (const entry of [...onSinks.map((e) => e.item), ...inPending]) check(JSON.stringify(entry.via) === JSON.stringify(via), `${name}: placed with via ${JSON.stringify(entry.via)}, written with ${JSON.stringify(via)}`);
    }
  }
  // 5. no re-send storm (D49): within one session the front end never sends a slot twice under the same inc (a second copy under an
  // inc the owner already refused is refused again, for ever).
  const sessionCopies = new Set<string>();
  for (const frame of server.received) {
    if (frame.t === "hello") sessionCopies.clear();
    else if (frame.t === "cmd") {
      const copyKey = `${slotKey(frame.slot)} ${frame.inc}`;
      check(!sessionCopies.has(copyKey), `slot ${frame.slot.n} sent twice under ${frame.inc} in one session`);
      sessionCopies.add(copyKey);
    }
  }
  for (const entry of shown) check(messages.has((entry.item as unknown as { cmd: { messageId: string } }).cmd.messageId), "a sink got an item nobody submitted");
  // 4. the row's end state
  if (link.state === "live") {
    const running = new Map(loader.loaded().map((entry) => [entry.name, entry]));
    for (const plugin of PLUGINS) {
      const index = table.get(plugin);
      const version = index === undefined ? null : VERSIONS[plugin]![index]!;
      if (!version?.ref) check(!running.has(plugin), `row of ${plugin} is ${version ? "without a web part" : "gone"}, but ${running.get(plugin)?.codeHash.slice(0, 6)} runs`);
      else if (!failing.has(version.ref)) check(running.get(plugin)?.codeHash === version.codeHash, `row of ${plugin} names version ${index! + 1}, running ${running.get(plugin)?.codeHash.slice(0, 6) ?? "nothing"}`);
      else if (running.has(plugin)) check(VERSIONS[plugin]!.some((v) => v.codeHash === running.get(plugin)!.codeHash), `${plugin} runs code no row ever named`);
    }
  }

  if (violations.length) violations.push(`link ${link.state} (server connected ${server.connected}); steps: ${trace.join(" ")}; link log: ${linkLog.slice(-14).join(" ")}; pending: ${link.pending().map((view) => `${(view.cmd as { messageId: string }).messageId}:${view.state}${view.stopped ? "/stopped" : ""}${view.lost ? "/lost" : ""}`).join(" ")}`);
  offOutcomes();
  offRows();
  await loader.stop();
  await link.stop();
  server.db.close();
  return { violations, messages: messages.size, swaps, cuts, restores, lostEvents, instance, pending, none };
}

describe("P7 stand-in (M7-11b): one outcome per outbox item across plugin swaps", () => {
  it(`${RUNS} seeded runs: every item has one outcome, applied at most once, placed once on the live instance or in the pending view`, async () => {
    const totals = { runs: 0, messages: 0, swaps: 0, cuts: 0, restores: 0, lostEvents: 0, instance: 0, pending: 0, none: 0 };
    const started = Date.now();
    const runs = [
      ...(ONE && (HOLD || LOSSY) ? [] : seeds().map((s) => [s, false, false] as const)),
      ...(ONE && LOSSY ? [] : holdSeeds().map((s) => [s, true, false] as const)),
      ...lossySeeds().map((s) => [s, true, true] as const),
    ];
    for (const [seed, hold, lossy] of runs) {
      const result = await oneRun(seed, hold, lossy);
      const mode = lossy ? " with late resets and a lossy wire" : hold ? " with late resets" : "";
      if (result.violations.length) throw new Error(`seed ${seed}${mode} (replay: SWAP_OUTBOX_SEED=${seed}${lossy ? " SWAP_OUTBOX_LOSSY=1" : hold ? " SWAP_OUTBOX_HOLD=1" : ""}):\n  ${result.violations.join("\n  ")}`);
      totals.runs += 1;
      for (const key of ["messages", "swaps", "cuts", "restores", "lostEvents", "instance", "pending", "none"] as const) totals[key] += result[key];
    }
    console.log(`[swap outbox] ${JSON.stringify({ ...totals, seconds: Math.round((Date.now() - started) / 100) / 10, firstSeed: FIRST_SEED })}`);
    if (!ONE) {
      // The generator reaches what the property is about (a vacuous run would pass anything).
      expect(totals.instance).toBeGreaterThan(totals.runs / 4);
      expect(totals.pending).toBeGreaterThan(totals.runs / 4);
      expect(totals.lostEvents).toBeGreaterThan(0);
      expect(totals.cuts).toBeGreaterThan(totals.runs);
      expect(totals.swaps).toBeGreaterThan(totals.runs);
    }
  }, 3_600_000);
});
