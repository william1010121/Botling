// M2 step 3: the session layer (src/session) in Node. The cases are the shared vectors (test/session-vectors.ts), which
// the headless Chromium and WebKit page runs too (test/acceptance/web-v3/session-vectors.test.ts); the Node-only checks
// follow them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memberIdFromKey, PROTOCOL_NAME, PROTOCOL_VERSION, FRAME_LIMIT } from "../../src/protocol";
import { memberIdOfSignKey, SESSION_FRAME_LIMIT, SESSION_PROTOCOL, SESSION_VERSION } from "../../src/session";
import { desktop } from "../helpers";
import { CASES, KNOWN_ANSWERS, KNOWN_PAIR_PROOF, knownAnswerOf, knownPairProof } from "../session-vectors";

describe("session layer vectors (Node)", () => {
  for (const [name, run] of Object.entries(CASES)) it(name, run, 20_000);
});

describe("session layer (Node only)", () => {
  it("prints the known answers when they are not filled in yet", async () => {
    if (KNOWN_ANSWERS.ik.sessionId) return;
    const answers = { ik: await knownAnswerOf("ik"), kk: await knownAnswerOf("kk"), pair: await knownAnswerOf("pair") };
    console.log(JSON.stringify({ answers, proof: await knownPairProof() }, null, 2));
    expect.fail("fill KNOWN_ANSWERS in test/session-vectors.ts");
  });

  it("agrees with the protocol module on name, version, frame limit and member ids", async () => {
    expect(SESSION_PROTOCOL).toBe(PROTOCOL_NAME);
    expect(SESSION_VERSION).toBe(PROTOCOL_VERSION);
    expect(SESSION_FRAME_LIMIT).toBe(FRAME_LIMIT);
    for (let n = 0; n < 20; n++) {
      const key = globalThis.crypto.getRandomValues(new Uint8Array(32));
      expect(await memberIdOfSignKey(key)).toBe(await memberIdFromKey(key));
    }
  });

  it("is isomorphic: no Node built-ins, no Electron, no zod, and the 2.x e2e.ts is not imported", () => {
    const dir = join(desktop, "src", "session");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const spec of imports) expect(spec.startsWith("./"), `${name} imports ${spec}`).toBe(true);
      expect(source).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b/);
    }
  });
});
