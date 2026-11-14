// The session layer's test vectors (M2 step 3), shared by the Node unit test (test/unit/session.test.ts) and the
// headless browser page (test/acceptance/web-v3/session-vectors.test.ts): the same cases, the same known answers.
// Isomorphic: no vitest, no Node built-ins; only src/session and WebCrypto.
//
// Each case returns normally when it passes and throws when it does not; `runSessionVectors` runs them all and
// reports one result per case (the browsers hand the list back to Node).
import {
  assertSharedSecret, dh, FRAME_KIND, generateDhKeyPair, importDhKeyPair, isSmallOrder, LaneQueue, memberIdOfSignKey,
  rawX25519, SessionError, SessionLink, signPairProof, SMALL_ORDER_POINTS, verifyPairProof,
  type DhKeyPair, type HandshakeMode, type LocalStatic, type PeerClaim, type PeerDecision, type SessionEnd, type SessionLimits, type SessionTransport, type TransportKind,
} from "../src/session";

export interface VectorResult { name: string; ok: boolean; detail: string }

// ---------------------------------------------------------------------------------------------
// Helpers

const hexOf = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));
const seq = (start: number, length = 32) => Uint8Array.from({ length }, (_, index) => (start + index) & 0xff);
const text = (value: string) => new TextEncoder().encode(value);
const read = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexOf(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer)));
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const X25519_PKCS8 = "302e020100300506032b656e04220420";
const ED25519_PKCS8 = "302e020100300506032b657004220420";
const fixedDh = (start: number) => importDhKeyPair(fromHex(X25519_PKCS8 + hexOf(seq(start))));

const CLUSTER = "0123456789abcdef0123456789abcdef";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function randomMemberId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(26));
  return [...bytes].map((byte) => BASE32[byte & 31]).join("");
}

async function identity(memberId = randomMemberId(), pair?: DhKeyPair): Promise<LocalStatic> {
  const keys = pair ?? await generateDhKeyPair();
  return { memberId, dhPub: keys.publicKey, dhKey: keys.privateKey };
}
const peerOf = (self: LocalStatic) => ({ memberId: self.memberId, dhPub: self.dhPub });

async function waitFor(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A tap sees each frame one side sends and returns the frames the other side receives (drop, repeat, alter, hold). */
type Tap = (frame: Uint8Array, index: number) => Uint8Array[];

interface Side {
  link: SessionLink;
  got: string[];
  ended: SessionEnd | null;
  sent: Uint8Array[];
}

interface PairSetup {
  mode?: HandshakeMode;
  transport?: TransportKind;
  responderTransport?: TransportKind;
  cluster?: string;
  responderCluster?: string;
  server?: LocalStatic;
  device?: LocalStatic;
  /** What the initiator believes the responder's static key is (default: the real one). */
  dialKey?: Uint8Array;
  secret?: Uint8Array;
  offer?: string;
  responderSecret?: Uint8Array | null;
  checkPeer?: (claim: PeerClaim) => Promise<PeerDecision> | PeerDecision;
  expectInitiator?: string;
  modes?: HandshakeMode[];
  limits?: Partial<SessionLimits>;
  now?: () => number;
  initiatorEphemeral?: DhKeyPair;
  responderEphemeral?: DhKeyPair;
  /** Frames initiator → responder. */
  tapI?: Tap;
  /** Frames responder → initiator. */
  tapR?: Tap;
}

/** A device (initiator) and a server (responder) joined by an in-memory transport. */
async function connect(setup: PairSetup = {}): Promise<{ i: Side; r: Side; server: LocalStatic; device: LocalStatic }> {
  const server = setup.server ?? await identity();
  const device = setup.device ?? await identity();
  const mode = setup.mode ?? "ik";
  const secret = setup.secret ?? (mode === "pair" ? seq(0x80) : undefined);
  const offer = setup.offer ?? "offer-0000000001";
  const i: Side = { link: null as unknown as SessionLink, got: [], ended: null, sent: [] };
  const r: Side = { link: null as unknown as SessionLink, got: [], ended: null, sent: [] };
  let countI = 0, countR = 0;
  const transportR: SessionTransport = {
    send: (frame) => { r.sent.push(frame); for (const out of setup.tapR ? setup.tapR(frame, countR++) : [frame]) i.link.receive(out); },
    close: () => { setTimeout(() => i.link.transportClosed(), 0); },
  };
  const transportI: SessionTransport = {
    send: (frame) => { i.sent.push(frame); for (const out of setup.tapI ? setup.tapI(frame, countI++) : [frame]) r.link.receive(out); },
    close: () => { setTimeout(() => r.link.transportClosed(), 0); },
  };
  r.link = SessionLink.respond(transportR, {
    transport: setup.responderTransport ?? setup.transport ?? "memory",
    cluster: setup.responderCluster ?? setup.cluster ?? CLUSTER,
    self: server,
    modes: setup.modes ?? ["kk", "ik", "pair"],
    expectInitiator: setup.expectInitiator ?? (mode === "kk" ? device.memberId : undefined),
    checkPeer: setup.checkPeer ?? ((claim) => ({ ok: claim.memberId === device.memberId && hexOf(claim.dhPub) === hexOf(device.dhPub) })),
    offerSecret: (id) => (id === offer ? (setup.responderSecret === undefined ? secret ?? null : setup.responderSecret) : null),
    limits: setup.limits, now: setup.now, ephemeral: setup.responderEphemeral,
  }, { onFrame: (bytes) => { r.got.push(read(bytes)); }, onEnd: (end) => { r.ended = end; } });
  i.link = SessionLink.initiate(transportI, {
    mode, transport: setup.transport ?? "memory", cluster: setup.cluster ?? CLUSTER, self: device,
    responder: { memberId: server.memberId, dhPub: setup.dialKey ?? server.dhPub },
    pair: mode === "pair" ? { offer, secret: secret! } : undefined,
    limits: setup.limits, now: setup.now, ephemeral: setup.initiatorEphemeral,
  }, { onFrame: (bytes) => { i.got.push(read(bytes)); }, onEnd: (end) => { i.ended = end; } });
  return { i, r, server, device };
}

async function opened(pair: { i: Side; r: Side }) {
  const [a, b] = await Promise.all([pair.i.link.established, pair.r.link.established]);
  return { i: a, r: b };
}

async function expectEnd(side: Side, reason: SessionEnd["reason"], what: string): Promise<void> {
  await waitFor(() => side.ended !== null, `${what}: the session to end`);
  check(side.ended!.reason === reason, `${what}: ended with ${side.ended!.reason} (${side.ended!.detail}), expected ${reason}`);
}

async function expectRefused(promise: Promise<unknown>, reason: SessionEnd["reason"], what: string): Promise<void> {
  try { await promise; } catch (error) {
    check(error instanceof SessionError, `${what}: threw ${String(error)}`);
    check(error.reason === reason, `${what}: refused with ${error.reason} (${error.message}), expected ${reason}`);
    return;
  }
  throw new Error(`${what}: was not refused`);
}

// ---------------------------------------------------------------------------------------------
// Known answers: fixed static and ephemeral keys, so every byte on the wire is fixed. Computed once in Node and
// written here; the browsers must produce the same bytes (one implementation, three engines).

export const KNOWN_ANSWERS: Record<"ik" | "kk" | "pair", { sessionId: string; code: string; transcript: string; hs1: string; hs2: string; hs3: string; data: string }> = {
  ik: {
    sessionId: "FiS91d0LNkCP3GsH88e8ng", code: "710191",
    transcript: "1624bdd5dd0b36408fdc6b07f3c7bc9e0aea6b83fbd19c5e35f4028f42acb1d9",
    hs1: "6ffc450bb249b3e5b946c9fdde80e20b58309dbea39dc9723d719949f70b322e",
    hs2: "4ae5ebce590d37bdc8099db633da467b432209d51242d07c3990295baf3850a6",
    hs3: "33f616d0b46c843b63d75d9e715066a8f33611c38e30ae700757442d9728a564",
    data: "1db4d75382d50b082fc0b6d0b002791f97892c1a69329521b5eb3ef002ff3662",
  },
  kk: {
    sessionId: "kJVJDfxPzTPoSVMVR-KJtQ", code: "054096",
    transcript: "9095490dfc4fcd33e849531547e289b5eee56954380a554ba7c52daae9f95693",
    hs1: "9577047d2600965f2cee2e60346ca9e5ea193829986be541795fd11ba6d73d2c",
    hs2: "8279aa3137b64cc32c935b74cf0c23d43ee01d39b3802c8675a6e186dcfb6b9f",
    hs3: "4ec0619beda3dd1cf79e6e7f566db2d2ee2199b8f80159ca7ff01bb66bb63cbd",
    data: "e2d3353472744401662caa22f478840d448edefd0d7bcd5a5bf684b3023b646d",
  },
  pair: {
    sessionId: "tW1pidVSh2mOsH8q-J2hpA", code: "170862",
    transcript: "b56d6989d55287698eb07f2af89da1a4debd9ca1067039fa4e7e87453ea96ccb",
    hs1: "fdec203a4a0872c7eb2b39635070800c090b6d7591e75b53927267793ae2f2e9",
    hs2: "bca7cb0d989d65bebe35f5e9a40c19a54c85afa2909123698e50f2b331bcf69f",
    hs3: "5449611f0086df219c21a79a465a0536d3de4b0caca109612a3636a93c7b717f",
    data: "6bbab893547708dd1c89eca641f1c2386d4d03221ba091ba42c17addacac175b",
  },
};
export const KNOWN_PAIR_PROOF = "939501d51fe1e52e2425848a5549b05d550ae2c10c3ffeb20154f9ec0a962694fd460231a4deb5b18ffc77fa8e87af823f1ebe3e9e14675fef93b71f07b00501";

const KAT_SERVER = "srv".padEnd(26, "a");
const KAT_DEVICE = "dev".padEnd(26, "b");

/** The fixed-key handshake of one mode: what the wire carried. */
export async function knownAnswerOf(mode: "ik" | "kk" | "pair") {
  const server = await identity(KAT_SERVER, await fixedDh(0x01));
  const device = await identity(KAT_DEVICE, await fixedDh(0x21));
  const pair = await connect({
    mode, server, device, offer: "offer-kat-000001", secret: seq(0x80),
    initiatorEphemeral: await fixedDh(0x41), responderEphemeral: await fixedDh(0x61),
  });
  const info = await opened(pair);
  pair.i.link.send("control", text("known answer"));
  await waitFor(() => pair.r.got.length === 1, "the known-answer frame");
  const answer = {
    sessionId: info.i.sessionId, code: info.i.code, transcript: hexOf(info.i.transcriptHash),
    hs1: await sha256Hex(pair.i.sent[0]!), hs2: await sha256Hex(pair.r.sent[0]!), hs3: await sha256Hex(pair.i.sent[1]!), data: await sha256Hex(pair.i.sent[2]!),
  };
  check(info.r.sessionId === info.i.sessionId && info.r.code === info.i.code, `${mode}: the two sides disagree`);
  pair.i.link.close();
  return answer;
}

/** The fixed Ed25519 key's signature over a fixed transcript hash, and its public key. */
export async function knownPairProof(): Promise<string> {
  const { signKey } = await fixedSignKey();
  return hexOf(await signPairProof(signKey, seq(0x10)));
}

async function fixedSignKey(): Promise<{ signKey: CryptoKey; signPub: Uint8Array }> {
  const pkcs8 = fromHex(ED25519_PKCS8 + hexOf(seq(0xa0))).buffer as ArrayBuffer;
  const probe = await globalThis.crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const x = (await globalThis.crypto.subtle.exportKey("jwk", probe)).x!;
  const signPub = Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (x.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
  const signKey = await globalThis.crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { signKey, signPub };
}

// ---------------------------------------------------------------------------------------------
// The cases

const tamper = (frame: Uint8Array, at: number) => { const copy = new Uint8Array(frame); copy[at] = copy[at]! ^ 0x01; return copy; };

/** A session open in `mode`, with `count` frames sent each way before `then` runs. */
async function openSession(setup: PairSetup = {}) {
  const pair = await connect(setup);
  await opened(pair);
  return pair;
}

/** Sends data from the initiator with a tap on that direction; checks the responder ends with `reason` and delivers nothing after `good`. */
async function tamperCase(name: string, good: number, tap: Tap, reason: SessionEnd["reason"]): Promise<void> {
  // Frames initiator → responder: 0 HS1, 1 HS3, then data 2, 3, 4 …
  const pair = await openSession({ tapI: (frame, index) => (index < 2 ? [frame] : tap(frame, index - 2)) });
  for (let n = 0; n < 5; n++) pair.i.link.send("control", text(`m${n}`));
  await expectEnd(pair.r, reason, name);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check(pair.r.got.length === good, `${name}: ${pair.r.got.length} frames delivered, expected ${good} (${pair.r.got.join(",")})`);
  check(pair.r.got.every((value, index) => value === `m${index}`), `${name}: frames out of order`);
  pair.i.link.close();
}

export const CASES: Record<string, () => Promise<void>> = {
  async "known answers: IK, KK and pair handshakes give the same bytes in every engine"() {
    for (const mode of ["ik", "kk", "pair"] as const) {
      const got = await knownAnswerOf(mode);
      const want = KNOWN_ANSWERS[mode];
      for (const key of Object.keys(want) as (keyof typeof want)[]) check(got[key] === want[key], `${mode}.${key}: got ${got[key]}, expected ${want[key]}`);
    }
    // Ed25519 signatures need not be byte-identical across engines (WebKit's are randomized, Node's and Chromium's are
    // deterministic); what must hold is that each engine verifies the known one and its own.
    const { signPub } = await fixedSignKey();
    const memberId = await memberIdOfSignKey(signPub);
    check(await verifyPairProof(signPub, memberId, seq(0x10), fromHex(KNOWN_PAIR_PROOF)), "the known pair proof does not verify");
    check(await verifyPairProof(signPub, memberId, seq(0x10), fromHex(await knownPairProof())), "this engine's pair proof does not verify");
  },

  async "both sides derive the same session id, transcript and 6-digit code (IK, KK, pair), and frames flow both ways"() {
    for (const mode of ["ik", "kk", "pair"] as const) {
      const pair = await connect({ mode });
      const info = await opened(pair);
      check(info.i.sessionId === info.r.sessionId, `${mode}: session ids differ`);
      check(hexOf(info.i.transcriptHash) === hexOf(info.r.transcriptHash), `${mode}: transcripts differ`);
      check(/^[0-9]{6}$/.test(info.i.code) && info.i.code === info.r.code, `${mode}: codes ${info.i.code} / ${info.r.code}`);
      check(info.r.peer.memberId === pair.device.memberId && info.i.peer.memberId === pair.server.memberId, `${mode}: wrong peer ids`);
      check(info.i.mode === mode && info.r.mode === mode, `${mode}: wrong mode`);
      for (let n = 0; n < 10; n++) { pair.i.link.send("control", text(`up ${n}`)); pair.r.link.send("bulk", text(`down ${n}`)); }
      await waitFor(() => pair.r.got.length === 10 && pair.i.got.length === 10, `${mode}: frames both ways`);
      check(pair.r.got.join() === Array.from({ length: 10 }, (_, n) => `up ${n}`).join(), `${mode}: up frames out of order`);
      check(pair.i.got.join() === Array.from({ length: 10 }, (_, n) => `down ${n}`).join(), `${mode}: down frames out of order`);
      pair.i.link.close();
    }
  },

  async "two pairings of the same offer and keys give different codes (fresh ephemerals)"() {
    const server = await identity(), device = await identity();
    const a = await opened(await connect({ mode: "pair", server, device }));
    const b = await opened(await connect({ mode: "pair", server, device }));
    check(a.i.sessionId !== b.i.sessionId, "two sessions share an id");
  },

  async "pair mode: a wrong secret, an unknown offer or no offer lookup is refused"() {
    const wrong = await connect({ mode: "pair", responderSecret: seq(0x90) });
    await expectEnd(wrong.r, "handshake", "wrong secret");
    check(wrong.r.sent.length === 0, "wrong secret: the responder answered");
    const unknown = await connect({ mode: "pair", responderSecret: null });
    await expectEnd(unknown.r, "offer", "unknown offer");
  },

  async "the roster check refuses an initiator: no HS2, nothing delivered"() {
    const pair = await connect({ checkPeer: () => ({ ok: false, detail: "revoked" }) });
    await expectEnd(pair.r, "roster", "refused initiator");
    check(pair.r.sent.length === 0, "the responder answered a refused initiator");
    await expectRefused(pair.i.link.established, "transport", "the initiator's side");
  },

  async "a frame before the roster check is never parsed (check pending, then refused)"() {
    let release!: (decision: PeerDecision) => void;
    let claims = 0;
    const pair = await connect({ checkPeer: () => { claims++; return new Promise<PeerDecision>((resolve) => { release = resolve; }); } });
    await waitFor(() => claims === 1, "the roster check to start");
    // Frames that arrive while the check runs: shaped like data frames, an HS3, garbage.
    const early = [
      Uint8Array.of(FRAME_KIND.DATA, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, ...seq(0, 40)),
      Uint8Array.of(FRAME_KIND.HS3, ...seq(7, 48)),
      seq(3, 100),
    ];
    for (const frame of early) pair.r.link.receive(frame);
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(pair.r.ended === null && pair.r.link.delivered === 0 && pair.r.got.length === 0, "a frame was handled while the roster check ran");
    release({ ok: false });
    await expectEnd(pair.r, "roster", "refused after early frames");
    check(pair.r.link.delivered === 0 && pair.r.got.length === 0 && pair.r.sent.length === 0, "an early frame was opened or answered");
  },

  async "a frame before HS3 is never parsed (check passed, data frame instead of HS3)"() {
    // The initiator's HS3 is replaced by a data-shaped frame: the responder ends without opening anything.
    const pair = await connect({ tapI: (frame, index) => (index === 1 ? [Uint8Array.of(FRAME_KIND.DATA, ...frame.subarray(1), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)] : [frame]) });
    await expectEnd(pair.r, "handshake", "data before HS3");
    check(pair.r.link.delivered === 0, "a frame was delivered before HS3");
  },

  async "nothing queued is sent before the session opens, and it all goes right after"() {
    let release!: (decision: PeerDecision) => void;
    const pair = await connect({ checkPeer: () => new Promise<PeerDecision>((resolve) => { release = resolve; }) });
    pair.i.link.send("control", text("early 1"));
    pair.r.link.send("control", text("welcome"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    check(pair.i.sent.length === 1 && pair.r.sent.length === 0, "a data frame left before the handshake finished");
    release({ ok: true });
    await waitFor(() => pair.r.got.length === 1 && pair.i.got.length === 1, "the queued frames");
    check(pair.r.got[0] === "early 1" && pair.i.got[0] === "welcome", "wrong queued frames");
    pair.i.link.close();
  },

  "a replayed frame ends the session": () => tamperCase("replay", 3, (frame, n) => (n === 2 ? [frame, frame] : [frame]), "order"),
  "a skipped (dropped) frame ends the session": () => tamperCase("skip", 1, (frame, n) => (n === 1 ? [] : [frame]), "order"),
  "reordered frames end the session": () => {
    let held: Uint8Array | null = null;
    return tamperCase("reorder", 1, (frame, n) => { if (n === 1) { held = frame; return []; } if (n === 2) return [frame, held!]; return [frame]; }, "order");
  },
  "an altered ciphertext byte ends the session": () => tamperCase("alter body", 1, (frame, n) => (n === 1 ? [tamper(frame, frame.length - 17)] : [frame]), "auth"),
  "an altered tag ends the session": () => tamperCase("alter tag", 1, (frame, n) => (n === 1 ? [tamper(frame, frame.length - 1)] : [frame]), "auth"),
  "an altered counter ends the session": () => tamperCase("alter counter", 1, (frame, n) => (n === 1 ? [tamper(frame, 12)] : [frame]), "order"),
  "an altered epoch ends the session": () => tamperCase("alter epoch", 1, (frame, n) => (n === 1 ? [tamper(frame, 4)] : [frame]), "order"),
  "an altered frame kind ends the session": () => tamperCase("alter kind", 1, (frame, n) => (n === 1 ? [Uint8Array.of(FRAME_KIND.SWITCH, ...frame.subarray(1))] : [frame]), "auth"),
  "a kind the sender may not send ends the session": () => tamperCase("wrong kind", 1, (frame, n) => (n === 1 ? [Uint8Array.of(FRAME_KIND.REKEY_ACK, ...frame.subarray(1))] : [frame]), "malformed"),
  "a truncated frame ends the session": () => tamperCase("truncate", 1, (frame, n) => (n === 1 ? [frame.subarray(0, 20)] : [frame]), "malformed"),
  "a frame from another session ends the session": async () => {
    const other = await openSession();
    other.i.link.send("control", text("elsewhere"));
    await waitFor(() => other.r.got.length === 1, "the other session's frame");
    const foreign = other.i.sent[2]!; // its first data frame: epoch 0, counter 1
    other.i.link.close();
    await tamperCase("foreign", 0, (frame, n) => (n === 0 ? [foreign] : [frame]), "auth");
  },

  async "an altered HS1, HS2 or HS3 ends the handshake"() {
    const hs1 = await connect({ tapI: (frame, index) => (index === 0 ? [tamper(frame, frame.length - 3)] : [frame]) });
    await expectEnd(hs1.r, "handshake", "altered HS1");
    const hs2 = await connect({ tapR: (frame, index) => (index === 0 ? [tamper(frame, 40)] : [frame]) });
    await expectEnd(hs2.i, "handshake", "altered HS2");
    const hs3 = await connect({ tapI: (frame, index) => (index === 1 ? [tamper(frame, 10)] : [frame]) });
    await expectEnd(hs3.r, "handshake", "altered HS3");
    const mode = await connect({ mode: "ik", tapI: (frame, index) => (index === 0 ? [Uint8Array.of(frame[0]!, frame[1]!, 1, ...frame.subarray(3))] : [frame]) });
    await expectEnd(mode.r, "handshake", "IK relabelled as KK");
  },

  async "a wrong responder key, cluster or transport fails the handshake"() {
    const wrongKey = await connect({ dialKey: (await generateDhKeyPair()).publicKey });
    await expectEnd(wrongKey.r, "handshake", "wrong responder key");
    const wrongCluster = await connect({ responderCluster: "fedcba9876543210fedcba9876543210" });
    await expectEnd(wrongCluster.r, "handshake", "wrong cluster");
    const wrongTransport = await connect({ transport: "tailnet", responderTransport: "relay" });
    await expectEnd(wrongTransport.r, "handshake", "wrong transport");
  },

  async "KK refuses an initiator other than the expected one; a mode the responder does not take is refused"() {
    const kk = await connect({ mode: "kk", expectInitiator: randomMemberId() });
    await expectEnd(kk.r, "roster", "unexpected KK initiator");
    const notTaken = await connect({ mode: "pair", modes: ["ik"] });
    await expectEnd(notTaken.r, "handshake", "pair not taken");
  },

  async "small-order public keys are refused everywhere a peer key enters"() {
    const own = await generateDhKeyPair();
    for (const point of SMALL_ORDER_POINTS) {
      check(isSmallOrder(point), `${hexOf(point)} not recognised`);
      const highBit = new Uint8Array(point); highBit[31] = highBit[31]! | 0x80;
      check(isSmallOrder(highBit), `${hexOf(point)} with the top bit set not recognised`);
      await expectRefused(dh(own.privateKey, point), "small-order", `dh with ${hexOf(point)}`);
      await expectRefused(dh(own.privateKey, highBit), "small-order", `dh with ${hexOf(highBit)}`);
    }
    check(!isSmallOrder(own.publicKey), "a real key is called small-order");
    const point = SMALL_ORDER_POINTS[2]!;
    // As the responder's static key: the initiator refuses before sending anything.
    const responderStatic = await connect({ dialKey: point });
    await expectRefused(responderStatic.i.link.established, "small-order", "small-order responder key");
    check(responderStatic.i.sent.length === 0, "HS1 was sent to a small-order key");
    // As the initiator's static key (inside HS1): the responder refuses before the roster check.
    let checked = 0;
    const device = await identity();
    const initiatorStatic = await connect({ device: { ...device, dhPub: point }, checkPeer: () => { checked++; return { ok: true }; } });
    await expectEnd(initiatorStatic.r, "small-order", "small-order initiator static");
    check(checked === 0, "the roster check saw a small-order key");
    // As the initiator's ephemeral (HS1 bytes 4..36) and the responder's (HS2 bytes 1..33).
    const ei = await connect({ tapI: (frame, index) => (index === 0 ? [Uint8Array.of(...frame.subarray(0, 4), ...point, ...frame.subarray(36))] : [frame]) });
    await expectEnd(ei.r, "small-order", "small-order initiator ephemeral");
    const er = await connect({ tapR: (frame, index) => (index === 0 ? [Uint8Array.of(frame[0]!, ...point, ...frame.subarray(33))] : [frame]) });
    await expectEnd(er.i, "small-order", "small-order responder ephemeral");
  },

  async "an all-zero DH result is refused whatever the engine does with a small-order point"() {
    let threw = false;
    try { assertSharedSecret(new Uint8Array(32)); } catch (error) { threw = error instanceof SessionError && error.reason === "small-order"; }
    check(threw, "an all-zero secret was accepted");
    assertSharedSecret(seq(1));
    // The engine alone (no list): it either throws or gives zeros for every small-order point; never a usable secret.
    const own = await generateDhKeyPair();
    for (const point of SMALL_ORDER_POINTS) {
      let bits: Uint8Array | null = null;
      try { bits = await rawX25519(own.privateKey, point); } catch { bits = null; }
      check(bits === null || bits.every((byte) => byte === 0), `the engine gave a non-zero secret for ${hexOf(point)}`);
    }
  },

  async "rekey continues the session: same id, frames in order both ways across several epochs"() {
    const pair = await openSession({ limits: { rekeyAfterFrames: 8, hardFrameMargin: 64 } });
    const sessionId = pair.i.link.info!.sessionId;
    for (let n = 0; n < 60; n++) {
      pair.i.link.send("control", text(`u${n}`));
      if (n % 3 === 0) pair.r.link.send("bulk", text(`d${n}`));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await waitFor(() => pair.r.got.length === 60 && pair.i.got.length === 20, "frames across rekeys");
    check(pair.r.got.join() === Array.from({ length: 60 }, (_, n) => `u${n}`).join(), "up frames out of order across rekeys");
    check(pair.i.got.join() === Array.from({ length: 20 }, (_, n) => `d${n * 3}`).join(), "down frames out of order across rekeys");
    const epochs = pair.i.link.epochs;
    check(epochs.send >= 3 && epochs.receive >= 3, `only ${epochs.send}/${epochs.receive} epochs`);
    check(pair.i.link.info!.sessionId === sessionId && pair.i.link.state === "open" && pair.r.link.state === "open", "the session did not continue");
    const kinds = new Set(pair.i.sent.map((frame) => frame[0]));
    check(kinds.has(FRAME_KIND.REKEY) && kinds.has(FRAME_KIND.SWITCH), "no rekey frames were sent");
    pair.i.link.close();
  },

  async "after a rekey, a frame of the old epoch is a replay and ends the session"() {
    let oldFrame: Uint8Array | null = null;
    let injected = false;
    const pair = await openSession({
      limits: { rekeyAfterFrames: 4, hardFrameMargin: 64 },
      tapI: (frame, index) => {
        if (index === 2) oldFrame = frame; // the first data frame of epoch 0
        if (!injected && oldFrame && frame[0] === FRAME_KIND.DATA && frame[4] === 1) { injected = true; return [frame, oldFrame]; }
        return [frame];
      },
    });
    for (let n = 0; n < 60 && !pair.r.ended; n++) {
      pair.i.link.send("control", text(`m${n}`));
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await expectEnd(pair.r, "order", "old-epoch replay");
    check(injected, "the old frame was never injected");
  },

  async "rekey after the time limit; a direction past the hard limit without a rekey ends the session"() {
    let clock = 1_000_000;
    const pair = await openSession({ now: () => clock, limits: { rekeyAfterMs: 1_000, hardAgeMarginMs: 500 } });
    pair.i.link.send("control", text("before"));
    await waitFor(() => pair.r.got.length === 1, "the first frame");
    clock += 1_200;
    pair.i.link.send("control", text("after"));
    pair.r.link.send("control", text("down"));
    await waitFor(() => pair.r.got.length === 2 && pair.i.got.length === 1, "frames after the time limit");
    await waitFor(() => pair.i.link.epochs.send === 1 && pair.r.link.epochs.receive === 1 && pair.r.link.epochs.send === 1, "the rekey after the time limit");
    pair.i.link.close();
    // The responder never rekeys; when the initiator does not either, the hard frame limit ends the session.
    const stuck = await openSession({ limits: { rekeyAfterFrames: 4, hardFrameMargin: 3 }, tapI: (frame) => (frame[0] === FRAME_KIND.REKEY ? [] : [frame]) });
    for (let n = 0; n < 12; n++) stuck.i.link.send("control", text(`s${n}`));
    await waitFor(() => stuck.r.ended !== null || stuck.i.ended !== null, "the stuck session to end");
    const reasons = [stuck.r.ended?.reason, stuck.i.ended?.reason];
    check(reasons.includes("order") || reasons.includes("limit"), `ended with ${reasons.join("/")}`);
  },

  async "lanes: control frames leave before bulk frames queued earlier"() {
    const queue = new LaneQueue();
    queue.push("bulk", text("b1"));
    queue.push("bulk", text("b2"));
    queue.push("control", text("c1"));
    check(queue.shift()!.lane === "control", "control did not go first");
    check(read(queue.shift()!.plaintext) === "b1", "bulk order lost");
    let threw = false;
    try { queue.push("bulk", new Uint8Array(queue.bulkFrameLimit + 1)); } catch { threw = true; }
    check(threw, "an oversized bulk frame was queued");
    const pair = await openSession();
    for (let n = 0; n < 3; n++) pair.r.link.send("bulk", text(`bulk ${n}`));
    pair.r.link.send("control", text("approval"));
    await waitFor(() => pair.i.got.length === 4, "lane frames");
    check(pair.i.got.indexOf("approval") <= 1, `the control frame waited behind ${pair.i.got.indexOf("approval")} bulk frames`);
    pair.i.link.close();
  },

  async "pair proof: the device's signature over the transcript verifies only with its key and member id"() {
    const pair = await connect({ mode: "pair" });
    const info = await opened(pair);
    const sign = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    const signPub = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", sign.publicKey));
    const memberId = await memberIdOfSignKey(signPub);
    const proof = await signPairProof(sign.privateKey, info.i.transcriptHash);
    check(await verifyPairProof(signPub, memberId, info.r.transcriptHash, proof), "a good proof did not verify");
    check(!await verifyPairProof(signPub, randomMemberId(), info.r.transcriptHash, proof), "a proof verified for another member id");
    check(!await verifyPairProof(signPub, memberId, seq(9), proof), "a proof verified for another transcript");
    check(!await verifyPairProof(signPub, memberId, info.r.transcriptHash, tamper(proof, 5)), "an altered proof verified");
    pair.i.link.close();
  },

  async "a closed session refuses to send, and the peer sees the transport close"() {
    const pair = await openSession();
    pair.i.link.close();
    let threw = false;
    try { pair.i.link.send("control", text("late")); } catch (error) { threw = error instanceof SessionError && error.reason === "closed"; }
    check(threw, "a closed session accepted a frame");
    await expectEnd(pair.r, "transport", "the peer");
  },
};

/** Runs every case (or the named ones) and reports each. */
export async function runSessionVectors(only?: string[]): Promise<VectorResult[]> {
  const results: VectorResult[] = [];
  for (const [name, run] of Object.entries(CASES)) {
    if (only && !only.includes(name)) continue;
    try { await run(); results.push({ name, ok: true, detail: "" }); }
    catch (error) { results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
