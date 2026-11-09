// Phone pairing (spec/models/relaypair) against the real code, through the adapter only.
// RelayPair: random walks of the reference (fixed seeds) drive the real RelayConnector and phones speaking the
// real protocol. The connector stops before each modelled step; the walk lets one peer go at a time, and phones,
// drops, the relay's close, expiry and revokes happen in between. Every step the connector takes must be the one
// the model allows that peer, and what can be seen (offers used and claimed, devices stored, where each peer is,
// frames on their way to each phone) must agree after every step. A frame reaching a peer that can take it is taken
// at once (the model's Take). Not driven: a revoke while `paired`/`res` is being sealed (the steps stop before the
// seal), and the HANDSHAKE_MS timer. The scripted tests replay TLC's counterexamples.
// LanPair: random sequences of whole operations (create, redeem, revoke, expiry) on two real PairingStores sharing
// one folder must match the reference; the interleavings inside them, crashes and lost answers are TLC's alone.
// SPEC_BUG=relaypair turns on the old connector (no claim, steps resume on closed peers) in the reference: the
// RelayPair tests must then fail.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LanPairDriver, RelayPairDriver } from "../driver/relaypair-driver";
import {
  lanInit, lanNext, lanObserve, lanViolated, relayInit, relayNext, relayObserve, relayViolated,
  type LanConsts, type LanState, type RelayAction, type RelayConsts, type RelayState, type RelayStep,
} from "../reference/relaypair";
import { lanpairDriver, relaypairDriver } from "../../desktop/spec-adapters/relaypair-adapter";

const C: RelayConsts = { conns: ["p1", "p2", "p3"], offers: ["o1"], bug: process.env.SPEC_BUG === "relaypair" ? "old" : "none" };
const L: LanConsts = { procs: ["q1", "q2"], phones: ["a", "b"], codes: ["s1"], bug: "none" };
const WALKS = 150;
const STEPS = 80;

const dirs: string[] = [];
const scratch = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `spec-relaypair-${name}-`)); dirs.push(dir); return dir; };
const drivers: RelayPairDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** mulberry32: a small seeded generator, so every walk can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const label = (t: Pick<RelayStep, "action" | "conn" | "offer" | "device">) =>
  `${t.action}(${[t.conn, t.offer, t.device].filter(Boolean).join(",")})`;
const CHECKS = new Set(["HsCheck", "Confirm", "ReqCheck"]);
const STEPS_OF_PEER = new Set<RelayAction>(["HsCheck", "HsKeys", "Confirm", "Grant", "ReqCheck", "ReqSend"]);

async function relayFollower(driver: RelayPairDriver) {
  let s: RelayState = relayInit(C);
  const seen: string[] = [];
  const where = () => `after ${seen.join(" ")}`;
  const take = (want: Pick<RelayStep, "action" | "conn" | "offer" | "device">) => {
    const step = relayNext(C, s).find((t) => t.action === want.action && t.conn === want.conn
      && (want.offer === undefined || t.offer === want.offer) && (want.device === undefined || t.device === want.device));
    seen.push(label(want));
    expect(step, `the model does not allow ${label(want)} here; ${where()}`).toBeDefined();
    s = step!.state;
  };
  /** A frame that reached a peer able to take it is taken at once. */
  const settle = () => {
    const waiting = driver.waiting();
    for (const p of C.conns) if (CHECKS.has(waiting[p] ?? "") && !s.busy[p]) take({ action: "Take", conn: p });
    expect(driver.observe(), where()).toEqual(relayObserve(C, s));
    expect(relayViolated(C, s), where()).toEqual([]);
  };
  /** Does what the model's step `t` says, on the real code. */
  const act = async (t: Pick<RelayStep, "action" | "conn" | "offer" | "device">) => {
    const p = t.conn!;
    switch (t.action) {
      case "Make": await driver.make(t.offer!); break;
      case "Expire": await driver.expire(t.offer!); break;
      case "JoinPair": await driver.joinPair(p, t.offer!); break;
      case "JoinSession": await driver.joinSession(p, t.device!); break;
      case "Recv": expect(await driver.recv(p), `what ${p} reads; ${where()}`).toBe(s.down[p]![0]); break;
      case "Request": await driver.request(p); break;
      case "Drop": await driver.drop(p); break;
      case "DeskClose": await driver.deskClose(p); break;
      case "Revoke": await driver.revoke(p); take(t); take({ action: "RevokeDone", conn: p }); settle(); return;
      default:
        if (!STEPS_OF_PEER.has(t.action)) throw Error(`not a driver call: ${t.action}`);
        expect(await driver.step(p), `the step ${p} took; ${where()}`).toBe(t.action);
    }
    take(t);
    settle();
  };
  /** Steps the walk may choose (Take and RevokeDone follow from others). */
  const choices = () => relayNext(C, s).filter((t) => t.action !== "Take" && t.action !== "RevokeDone");
  const run = async (script: [RelayAction, string?, string?][]) => {
    for (const [action, conn, arg] of script) {
      await act({ action, conn, ...(action === "JoinPair" || action === "Make" || action === "Expire" ? { offer: arg ?? conn } : {}), ...(action === "JoinSession" ? { device: arg } : {}) });
    }
  };
  return { act, run, choices, state: () => s, seen };
}

const newRelay = async (name: string) => {
  const driver = await relaypairDriver({ conns: C.conns, offers: C.offers, root: scratch(name) });
  drivers.push(driver);
  return driver;
};

describe("relay pairing model: the real RelayConnector follows the reference", () => {
  it("random walks: phones pairing and connecting again, drops, the relay's close, expiry and revokes between any two steps", async () => {
    const reached = new Set<string>();
    for (let seed = 1; seed <= WALKS; seed++) {
      const rnd = random(seed);
      const walk = await relayFollower(await newRelay(`walk${seed}`));
      for (let i = 0; i < STEPS; i++) {
        const options = walk.choices();
        if (!options.length) break;
        // Lean towards progress: the connector's and the phone's own steps come up more often than the world's.
        const weight = (t: RelayStep) => (STEPS_OF_PEER.has(t.action) || t.action === "Recv" ? 6
          : t.action === "JoinPair" || t.action === "JoinSession" || t.action === "Request" ? 3 : 1);
        const weighted = options.flatMap((t) => Array<RelayStep>(weight(t)).fill(t));
        const t = weighted[Math.floor(rnd() * weighted.length)]!;
        await walk.act(t);
        reached.add(t.action);
        if (t.action === "Grant" && walk.state().mode[t.conn!] === "session") reached.add("GrantReady");
      }
      for (const d of drivers.splice(0)) d.close();
    }
    // The walks reach pairing, connecting again, requests and revokes.
    for (const a of ["Grant", "GrantReady", "ReqSend", "Revoke", "Drop", "DeskClose", "JoinSession"]) expect(reached, a).toContain(a);
  }, 120_000);

  it("two phones scanning one code: the second is told nope at the handshake (RelayPair_bug_race.cfg)", async () => {
    const driver = await newRelay("race");
    const walk = await relayFollower(driver);
    await walk.run([["Make", undefined, "o1"], ["JoinPair", "p1", "o1"], ["JoinPair", "p2", "o1"], ["HsCheck", "p1"], ["HsCheck", "p2"], ["Recv", "p2"], ["Recv", "p2"]]);
    expect(walk.state().ph.p2).toBe("refused"); // nope, then the kick: told before its socket closed
    expect(driver.observe().claim.o1).toBe("p1");
    await walk.run([["HsKeys", "p1"], ["Recv", "p1"], ["Confirm", "p1"], ["Grant", "p1"], ["Recv", "p1"]]);
    expect(driver.observe().store).toEqual(["p1"]);
  });

  it("a phone that leaves while its {t:'pair'} is being opened spends no code (RelayPair_bug.cfg)", async () => {
    const driver = await newRelay("closed");
    const walk = await relayFollower(driver);
    await walk.run([["Make", undefined, "o1"], ["JoinPair", "p1", "o1"], ["HsCheck", "p1"], ["HsKeys", "p1"], ["Recv", "p1"], ["Drop", "p1"], ["DeskClose", "p1"], ["Confirm", "p1"]]);
    expect(driver.observe()).toMatchObject({ used: { o1: false }, store: [] });
    // The code still pairs the next phone.
    await walk.run([["JoinPair", "p2", "o1"], ["HsCheck", "p2"], ["HsKeys", "p2"], ["Recv", "p2"], ["Confirm", "p2"], ["Grant", "p2"], ["Recv", "p2"]]);
    expect(driver.observe().store).toEqual(["p2"]);
  });

  it("a revoke while a phone's handshake has not set its device yet: confirm looks again, no ready (RelayPair_bug_recheck.cfg)", async () => {
    const driver = await newRelay("window");
    const walk = await relayFollower(driver);
    await walk.run([["Make", undefined, "o1"], ["JoinPair", "p1", "o1"], ["HsCheck", "p1"], ["HsKeys", "p1"], ["Recv", "p1"], ["Confirm", "p1"], ["Grant", "p1"], ["Recv", "p1"]]);
    await walk.run([["JoinSession", "p2", "p1"], ["HsCheck", "p2"], ["Revoke", "p1"], ["HsKeys", "p2"], ["Recv", "p2"], ["Confirm", "p2"], ["Recv", "p2"]]);
    expect(walk.state().ph.p2).toBe("lost");
    expect(driver.observe().store).toEqual([]);
    expect(walk.state().late).toEqual([]);
  });
});

describe("LAN pairing model: the real PairingStore follows the reference", () => {
  /** One whole operation of process `q`, as the model's steps, and the driver's answer checked against it. */
  function lanWalk(driver: LanPairDriver) {
    let s: LanState = lanInit(L);
    const take = (action: string, match: (t: ReturnType<typeof lanNext>[number]) => boolean) => {
      const step = lanNext(L, s).find((t) => t.action === action && match(t));
      expect(step, `the model does not allow ${action} here`).toBeDefined();
      s = step!.state;
    };
    const check = () => {
      expect(driver.observe()).toEqual(lanObserve(s));
      expect(lanViolated(L, s)).toEqual([]);
    };
    return {
      state: () => s,
      create(q: string, c: string) { take("BeginCreate", (t) => t.proc === q && t.code === c); take("Create", (t) => t.proc === q); driver.create(q, c); check(); },
      redeem(q: string, f: string, c: string) {
        take("BeginTake", (t) => t.proc === q && t.phone === f && t.code === c);
        take("Take", (t) => t.proc === q);
        if (s.st[q] === "issue") {
          take("BeginIssue", (t) => t.proc === q); take("Issue", (t) => t.proc === q); take("Answer", (t) => t.proc === q && t.result === "token");
        }
        expect(driver.redeem(q, f, c)).toBe(s.got[f]);
        check();
      },
      revoke(q: string, f: string) {
        const listed = s.clients.includes(f);
        take("BeginRevoke", (t) => t.proc === q && t.phone === f); take("Revoke", (t) => t.proc === q);
        expect(driver.revoke(q, f)).toBe(listed);
        check();
      },
      expire(c: string) { take("Expire", (t) => t.code === c); driver.expire(c); check(); },
    };
  }

  it("random sequences of create, redeem, revoke and expiry on two processes", () => {
    let tokens = 0, invalid = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = random(seed);
      const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)]!;
      const walk = lanWalk(lanpairDriver({ procs: L.procs, phones: L.phones, root: scratch(`lan${seed}`) }));
      for (let i = 0; i < 8; i++) {
        const s = walk.state();
        const q = pick(L.procs), f = pick(L.phones);
        const ops = [
          ...(s.made.includes("s1") ? [] : [() => walk.create(q, "s1")]),
          ...(s.made.includes("s1") && s.got[f] === "none" ? [() => walk.redeem(q, f, "s1")] : []),
          () => walk.revoke(q, f),
          ...(s.made.includes("s1") && !s.exp.includes("s1") ? [() => walk.expire("s1")] : []),
        ];
        pick(ops)();
      }
      tokens += Object.values(walk.state().got).filter((g) => g === "token").length;
      invalid += Object.values(walk.state().got).filter((g) => g === "invalid").length;
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    }
    expect(tokens).toBeGreaterThan(10);
    expect(invalid).toBeGreaterThan(10);
  });
});
