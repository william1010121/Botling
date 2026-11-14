// Botling 3 M3 step 4 review R1, interim (step-4-join.md "Review"): the typed code proves S to N only, so before S asks
// for it `botlingd add-machine` shows N's fingerprint and needs an explicit "yes" that N shows the same one (anything
// else, or no answer, cancels the attempt: nothing is added). Unattended use names the fingerprint it expects with
// `--expect-fingerprint`; a link for another server is then refused before anything is dialled.
import { describe, expect, it } from "vitest";
import { joinLink, memberFingerprint, memberIdFromKey, toBase64Url, type AdminOp } from "../../src/protocol";
import { addMachineCommand, type AdminClient } from "../../src/server/pairing";

async function serverKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  return {
    member: await memberIdFromKey(signPub),
    keys: { sign: toBase64Url(signPub), dh: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", dh.publicKey))) },
  };
}

async function linkFor(server: { member: string; keys: { sign: string; dh: string } }): Promise<string> {
  return joinLink({
    v: 1, offer: "o".repeat(22), server: server.member, name: "B", keys: server.keys, secret: toBase64Url(new Uint8Array(32).fill(7)),
    expiresAt: Date.now() + 60_000, addresses: ["ws://127.0.0.1:9/v3/ws"],
  });
}

/** A fake local socket: a cluster exists; machine.add answers for `server`; every code is wrong. */
function fakeClient(server: { member: string }) {
  const requests: AdminOp[] = [];
  const client = {
    closed: false,
    request: async (op: AdminOp) => {
      requests.push(op);
      switch (op.op) {
        case "cluster.status": return { clusterId: "c".repeat(32) };
        case "machine.add": return { attempt: "o".repeat(22), server: server.member, name: "B", fingerprint: memberFingerprint(server.member), self: { server: "s".repeat(26), fingerprint: memberFingerprint("s".repeat(26)) }, expiresAt: Date.now() + 60_000 };
        case "machine.code": return { ok: false, reason: "code" };
        case "machine.cancel": return { ok: true };
        default: return null;
      }
    },
    nextEvent: async () => null,
  } as unknown as AdminClient;
  return { client, requests };
}

function scriptedIo(answers: Array<string | null>) {
  const asked: string[] = [];
  const out: string[] = [];
  return { asked, out, io: { out: (line: string) => { out.push(line); }, ask: async (prompt: string) => { asked.push(prompt); return answers.length ? answers.shift()! : null; } } };
}

describe("R1 interim: add-machine needs N's fingerprint confirmed before the code", () => {
  it("asks whether N shows this fingerprint before it asks for the code; anything but yes cancels and sends no code", async () => {
    const n = await serverKeys();
    for (const answer of ["no", "", "y es", "53RV-XFK8"]) {
      const { client, requests } = fakeClient(n);
      const { io, asked } = scriptedIo([answer]);
      expect(await addMachineCommand(client, io, await linkFor(n))).toBe(1);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain(memberFingerprint(n.member));
      expect(asked[0]).toMatch(/yes/);
      expect(requests.some((op) => op.op === "machine.code")).toBe(false);
      expect(requests.at(-1)).toMatchObject({ op: "machine.cancel", attempt: "o".repeat(22) });
    }
  });

  it("no answer (stdin closed) cancels as well", async () => {
    const n = await serverKeys();
    const { client, requests } = fakeClient(n);
    const { io } = scriptedIo([]);
    expect(await addMachineCommand(client, io, await linkFor(n))).toBe(1);
    expect(requests.some((op) => op.op === "machine.code")).toBe(false);
    expect(requests.at(-1)).toMatchObject({ op: "machine.cancel" });
  });

  it("yes (any case) goes on to the code", async () => {
    const n = await serverKeys();
    const { client, requests } = fakeClient(n);
    const { io, asked } = scriptedIo(["YES", "53RV-XFK8"]);
    expect(await addMachineCommand(client, io, await linkFor(n))).toBe(1);
    expect(asked[1]).toMatch(/^Code shown on "B"/);
    expect(requests.find((op) => op.op === "machine.code")).toMatchObject({ code: "53RV-XFK8" });
  });

  it("--expect-fingerprint for another server refuses before dialling (no machine.add, no cluster made)", async () => {
    const n = await serverKeys();
    const other = await serverKeys();
    const { client, requests } = fakeClient(n);
    const { io, asked, out } = scriptedIo([]);
    expect(await addMachineCommand(client, io, await linkFor(n), { expectFingerprint: memberFingerprint(other.member) })).toBe(1);
    expect(requests.map((op) => op.op)).toEqual([]);
    expect(asked).toEqual([]);
    expect(out.join("\n")).toMatch(/fingerprint/i);
  });

  it("--expect-fingerprint that is not a fingerprint is refused before dialling", async () => {
    const n = await serverKeys();
    const { client, requests } = fakeClient(n);
    const { io } = scriptedIo([]);
    expect(await addMachineCommand(client, io, await linkFor(n), { expectFingerprint: "abc" })).toBe(1);
    expect(requests).toEqual([]);
  });

  it("a matching --expect-fingerprint (spacing and case free) skips the question and goes to the code", async () => {
    const n = await serverKeys();
    const { client, requests } = fakeClient(n);
    const { io, asked } = scriptedIo(["53RV-XFK8"]);
    const expected = memberFingerprint(n.member).toLowerCase().replace(/ /g, "");
    expect(await addMachineCommand(client, io, await linkFor(n), { expectFingerprint: expected })).toBe(1);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Code shown on "B"/);
    expect(requests.some((op) => op.op === "machine.code")).toBe(true);
  });
});
