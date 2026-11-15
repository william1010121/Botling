// M2 step 3 security review: one test per defect found in src/session (see .bot/artifacts/v3-m2/step-3-session.md,
// "Review"). Node only; the shared vectors (test/session-vectors.ts) stay as they are.
import { afterEach, describe, expect, it } from "vitest";
import { until } from "../helpers";
import {
  generateDhKeyPair, SessionLink, SESSION_FRAME_LIMIT,
  type HandshakeMode, type LocalStatic, type PeerClaim, type PeerDecision, type SessionEnd, type SessionLimits, type SessionTransport,
} from "../../src/session";

const CLUSTER = "0123456789abcdef0123456789abcdef";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const memberId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(26))].map((byte) => BASE32[byte & 31]).join("");
async function identity(): Promise<LocalStatic> {
  const keys = await generateDhKeyPair();
  return { memberId: memberId(), dhPub: keys.publicKey, dhKey: keys.privateKey };
}
const text = (value: string) => new TextEncoder().encode(value);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Side { link: SessionLink; got: Uint8Array[]; ended: SessionEnd | null }

interface Setup {
  mode?: HandshakeMode;
  device?: LocalStatic;
  expectInitiator?: string;
  modes?: HandshakeMode[];
  checkPeer?: (claim: PeerClaim) => PeerDecision;
  limits?: Partial<SessionLimits>;
  onFrameR?: (bytes: Uint8Array) => void | Promise<void>;
}

const links: SessionLink[] = [];
afterEach(() => { for (const link of links.splice(0)) link.close(); });

async function connect(setup: Setup = {}): Promise<{ i: Side; r: Side; server: LocalStatic; device: LocalStatic }> {
  const server = await identity();
  const device = setup.device ?? await identity();
  const mode = setup.mode ?? "ik";
  const i: Side = { link: null as unknown as SessionLink, got: [], ended: null };
  const r: Side = { link: null as unknown as SessionLink, got: [], ended: null };
  const toI: SessionTransport = { send: (frame) => i.link.receive(frame), close: () => { setTimeout(() => i.link.transportClosed(), 0); } };
  const toR: SessionTransport = { send: (frame) => r.link.receive(frame), close: () => { setTimeout(() => r.link.transportClosed(), 0); } };
  r.link = SessionLink.respond(toI, {
    transport: "memory", cluster: CLUSTER, self: server, modes: setup.modes ?? ["kk", "ik"],
    expectInitiator: setup.expectInitiator ?? (mode === "kk" ? device.memberId : undefined),
    checkPeer: setup.checkPeer ?? ((claim) => ({ ok: claim.memberId === device.memberId })),
    limits: setup.limits,
  }, { onFrame: setup.onFrameR ?? ((bytes) => { r.got.push(bytes); }), onEnd: (end) => { r.ended = end; } });
  i.link = SessionLink.initiate(toR, {
    mode, transport: "memory", cluster: CLUSTER, self: device, responder: { memberId: server.memberId, dhPub: server.dhPub }, limits: setup.limits,
  }, { onFrame: (bytes) => { i.got.push(bytes); }, onEnd: (end) => { i.ended = end; } });
  links.push(i.link, r.link);
  return { i, r, server, device };
}

describe("session layer security review (M2 step 3)", () => {
  it("R1: frames the peer (or the relay) pushes while onFrame is busy are bounded; a flood ends the session", async () => {
    let release!: () => void;
    const busy = new Promise<void>((resolve) => { release = resolve; });
    const pair = await connect({ onFrameR: () => busy });
    await Promise.all([pair.i.link.established, pair.r.link.established]);
    pair.i.link.send("control", text("first"));        // the responder's receiver now waits on `busy`
    await sleep(20);
    // A relay (or a bad member) appends full-size frames faster than they are opened: 160 × 256 KiB = 40 MiB.
    const junk = new Uint8Array(13 + SESSION_FRAME_LIMIT + 16);
    for (let n = 0; n < 160 && !pair.r.ended; n++) pair.r.link.receive(junk);
    expect(pair.r.ended?.reason).toBe("limit");
    release();
  });

  it("R1: a frame larger than any session frame is refused on arrival, not copied and queued", async () => {
    const pair = await connect({ checkPeer: () => new Promise<PeerDecision>(() => undefined) as unknown as PeerDecision });
    pair.r.link.receive(new Uint8Array(13 + SESSION_FRAME_LIMIT + 17));
    expect(pair.r.ended?.reason).toBe("malformed");
  });

  it("R2: a transport that throws on HS1 ends the session at once (no unhandled rejection, no 15 s wait)", async () => {
    const server = await identity(), device = await identity();
    let ended: SessionEnd | null = null;
    const link = SessionLink.initiate({ send: () => { throw new Error("socket gone"); }, close: () => undefined }, {
      mode: "ik", transport: "memory", cluster: CLUSTER, self: device, responder: { memberId: server.memberId, dhPub: server.dhPub },
    }, { onFrame: () => undefined, onEnd: (end) => { ended = end; } });
    links.push(link);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", onRejection);
    try {
      await sleep(100);
      expect(ended).not.toBeNull();
      expect(link.state).toBe("ended");
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("R3: a responder that expects one member refuses another member who dials in IK instead of KK", async () => {
    const expected = memberId();
    // The roster check accepts any valid member (as a server's would); the other member downgrades KK to IK.
    const pair = await connect({ mode: "ik", expectInitiator: expected, checkPeer: () => ({ ok: true }) });
    await pair.r.link.established.catch(() => undefined);
    await sleep(10);
    expect(pair.r.ended?.reason).toBe("roster");
    expect(pair.r.link.state).toBe("ended");
  });
});

describe("session layer: the transport closing right behind the last frame", () => {
  it("J1 root cause: a frame handed over just before the transport closed is still delivered, then the session ends", async () => {
    const pair = await connect();
    await Promise.all([pair.i.link.established, pair.r.link.established]);
    // The transport hands over the frame and, in the same turn, its close event (a socket's close comes right behind its
    // last message). Opening a frame is asynchronous, so the frame is still in flight when the close arrives.
    const receive = pair.r.link.receive.bind(pair.r.link);
    pair.r.link.receive = (frame) => { receive(frame); pair.r.link.transportClosed(); };
    pair.i.link.send("control", text("last words"));
    await until(() => pair.r.ended !== null, { what: "the responder's session to end" });
    expect(pair.r.got.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["last words"]);
    expect(pair.r.ended?.reason).toBe("transport");
  });

  it("a transport that closes while onFrame never returns still ends the session (bounded wait)", async () => {
    const pair = await connect({ onFrameR: () => new Promise<void>(() => undefined) });
    await Promise.all([pair.i.link.established, pair.r.link.established]);
    pair.i.link.send("control", text("stuck"));
    await sleep(20);
    pair.r.link.transportClosed();
    await until(() => pair.r.ended !== null, { timeout: 3_000, what: "the session to end although onFrame hangs" });
    expect(pair.r.ended?.reason).toBe("transport");
  });
});
