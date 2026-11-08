// The relay's end-to-end channel (src/mobile-relay/e2e.ts): both sides agree on keys, frames round-trip, and any
// change, replay, reordering, wrong pairing secret or wrong key is refused.
import { describe, expect, it } from "vitest";
import { b64u, deriveChannel, deviceIdOf, E2EError, generateKeyPair, offerIdOf, pairTokenOf, randomBytes, type KeyPair, type Transcript } from "../../src/mobile-relay/e2e";
import { parseRelayFragment, relayPairingURL } from "../../src/mobile-relay/protocol";

async function parties(mode: "pair" | "session" = "session") {
  const desk = { static: await generateKeyPair(), ephemeral: await generateKeyPair() };
  const phone = { static: await generateKeyPair(), ephemeral: await generateKeyPair() };
  const pairSecret = mode === "pair" ? randomBytes(32) : undefined;
  const t: Transcript = { mode, room: "r".repeat(43), deviceId: await deviceIdOf(phone.static.publicKey), deskStatic: desk.static.publicKey,
    phoneStatic: phone.static.publicKey, phoneEphemeral: phone.ephemeral.publicKey, deskEphemeral: desk.ephemeral.publicKey, pairSecret };
  return { desk, phone, t };
}
const flip = (frame: string, at = -3) => { const [c, data] = frame.split("."); const bytes = b64u.decode(data); bytes[bytes.length + at] ^= 1; return `${c}.${b64u.encode(bytes)}`; };

describe("relay end-to-end channel", () => {
  it("round-trips both ways with matching keys and a shared session id", async () => {
    const { desk, phone, t } = await parties();
    const d = await deriveChannel("desk", desk, t), p = await deriveChannel("phone", phone, t);
    expect(d.session).toBe(p.session);
    expect(await d.open(await p.seal({ t: "req", text: "hello 你好" }))).toEqual({ t: "req", text: "hello 你好" });
    expect(await p.open(await d.seal({ t: "res", n: 1 }))).toEqual({ t: "res", n: 1 });
    expect(await p.open(await d.seal({ t: "res", n: 2 }))).toEqual({ t: "res", n: 2 });
  });

  it("frames are ciphertext: the plaintext is not visible in them", async () => {
    const { desk, phone, t } = await parties();
    const p = await deriveChannel("phone", phone, t);
    await deriveChannel("desk", desk, t);
    const frame = await p.seal({ text: "my secret message" });
    expect(frame).not.toContain("secret");
    expect(Buffer.from(b64u.decode(frame.split(".")[1])).toString("latin1")).not.toContain("secret");
  });

  it("refuses a tampered frame and everything after it", async () => {
    const { desk, phone, t } = await parties();
    const d = await deriveChannel("desk", desk, t), p = await deriveChannel("phone", phone, t);
    const frame = await p.seal({ a: 1 });
    await expect(d.open(flip(frame))).rejects.toThrow(E2EError);
    await expect(d.open(frame)).rejects.toThrow(/closed/);
  });

  it("refuses replayed, reordered and relabelled frames", async () => {
    const { desk, phone, t } = await parties();
    const d = await deriveChannel("desk", desk, t), p = await deriveChannel("phone", phone, t);
    const first = await p.seal({ n: 0 }), second = await p.seal({ n: 1 });
    expect(await d.open(first)).toEqual({ n: 0 });
    await expect(d.open(first)).rejects.toThrow(/Replayed|order/);

    const d2 = await deriveChannel("desk", desk, t), p2 = await deriveChannel("phone", phone, t);
    const a = await p2.seal({ n: 0 }), b = await p2.seal({ n: 1 });
    await expect(d2.open(b)).rejects.toThrow(/order/);
    void a; void second;

    // Changing the counter in front of the ciphertext breaks its authentication (the counter is in the nonce and AAD).
    const d3 = await deriveChannel("desk", desk, t), p3 = await deriveChannel("phone", phone, t);
    const x = await p3.seal({ n: 0 }); await p3.seal({ n: 1 });
    await d3.open(x);
    await expect(d3.open(`1.${x.split(".")[1]}`)).rejects.toThrow(/authentication/);
  });

  it("a frame sent one way cannot be reflected back as the other side's", async () => {
    const { desk, phone, t } = await parties();
    const d = await deriveChannel("desk", desk, t), p = await deriveChannel("phone", phone, t);
    const fromPhone = await p.seal({ n: 0 });
    await expect(p.open(fromPhone)).rejects.toThrow(E2EError);
    void d;
  });

  it("pairing needs the QR secret: a different secret gives different keys", async () => {
    const { desk, phone, t } = await parties("pair");
    const d = await deriveChannel("desk", desk, t), p = await deriveChannel("phone", phone, { ...t, pairSecret: randomBytes(32) });
    await expect(d.open(await p.seal({ t: "pair" }))).rejects.toThrow(/authentication/);
    await expect(deriveChannel("desk", desk, { ...t, pairSecret: undefined })).rejects.toThrow(/secret/);
  });

  it("an impostor without the phone's (or the desktop's) private key cannot finish the handshake", async () => {
    const { desk, phone, t } = await parties();
    const d = await deriveChannel("desk", desk, t);
    // Someone who knows every public key but holds a different static key, claiming to be the phone.
    const impostor: { static: KeyPair; ephemeral: KeyPair } = { static: await generateKeyPair(), ephemeral: phone.ephemeral };
    const fake = await deriveChannel("phone", impostor, t);
    await expect(d.open(await fake.seal({ t: "hello" }))).rejects.toThrow(/authentication/);
    // And one pretending to be the desktop (a malicious relay) without its private key.
    const fakeDesk = await deriveChannel("desk", { static: await generateKeyPair(), ephemeral: desk.ephemeral }, t);
    const p = await deriveChannel("phone", phone, t);
    await expect(p.open(await fakeDesk.seal({ t: "ready" }))).rejects.toThrow(/authentication/);
  });

  it("refuses invalid public keys", async () => {
    const { desk, t } = await parties();
    await expect(deriveChannel("desk", desk, { ...t, phoneEphemeral: new Uint8Array(32) })).rejects.toThrow(E2EError);
    await expect(deriveChannel("desk", desk, { ...t, phoneStatic: new Uint8Array(31) })).rejects.toThrow(E2EError);
  });

  it("pairing link: secret only in the fragment, derived ids reveal nothing of it, parse round-trips", async () => {
    const secret = randomBytes(32), room = b64u.encode(randomBytes(32)), deskKey = b64u.encode((await generateKeyPair()).publicKey);
    const url = relayPairingURL("https://relay.example/mobile/", { room, deskKey, secret: b64u.encode(secret) });
    const parsed = new URL(url);
    expect(parsed.search).toBe("");
    expect(parsed.pathname).toBe("/mobile/");
    expect(parseRelayFragment(parsed.hash)).toEqual({ room, deskKey, secret: b64u.encode(secret) });
    expect(parseRelayFragment("#relay=x&k=y&s=z")).toBeNull();
    expect(parseRelayFragment(`#relay=${room}&k=${deskKey}&s=${b64u.encode(secret)}&w=${encodeURIComponent("ws://evil.example/ws")}`)).toBeNull();
    const token = await pairTokenOf(secret), offer = await offerIdOf(secret);
    expect(token).not.toBe(b64u.encode(secret));
    expect(offer).toHaveLength(22);
    expect(token).toHaveLength(43);
  });
});
