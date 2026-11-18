// Switching a bot to Antigravity checked the 405 MB runtime (SHA-256 of both files, two `codesign` runs) on every route check, head
// start and delivery, all synchronous: about 0.75 s each on a warm cache, three to five times per message, so the event loop was stuck
// for 3 s or more and the orchestration rules ask (limit 3 s) was reported as "did not answer in time". A file that passed is checked
// by its identity (device, inode, size, mtime, ctime) afterwards; a changed file, a wrong hash or a bad signature is checked in full.
import { renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACP_HARNESS_SHA, ACP_SERVER_SHA, fileIdentity, verifyAcpRuntime, type AcpVerifyDeps } from "../../src/core/agent/agy-acp";
import { tempDir } from "../helpers";

const SERVER = "/rt/agy_acp_server.par", HARNESS = "/rt/localharness_external";

function rig() {
  const identity = new Map<string, string>([[SERVER, "dev1:ino1:size:mtime:ctime"], [HARNESS, "dev1:ino2:size:mtime:ctime"]]);
  const digest = new Map<string, string>([[SERVER, ACP_SERVER_SHA], [HARNESS, ACP_HARNESS_SHA]]);
  const calls = { hash: [] as string[], codesign: [] as string[] };
  let signed = true;
  const deps: AcpVerifyDeps = {
    platform: "darwin", arch: "arm64", memo: new Map(),
    identity: (path) => { const value = identity.get(path); if (value === undefined) throw new Error(`ENOENT: ${path}`); return value; },
    hash: (path) => { calls.hash.push(path); return digest.get(path) ?? "no such file"; },
    codesign: (path) => { calls.codesign.push(path); if (!signed) throw new Error("code object is not signed at all"); },
  };
  return { deps, identity, digest, calls, sign: (value: boolean) => { signed = value; } };
}

describe("verifyAcpRuntime does the heavy check once per file, not once per call", () => {
  it("hashes and verifies the signature of both pinned files on the first call, and not again while they are unchanged", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    expect(r.calls.hash).toEqual([SERVER, HARNESS]);
    expect(r.calls.codesign).toEqual([SERVER, HARNESS]);
    for (let at = 0; at < 6; at++) verifyAcpRuntime(SERVER, r.deps); // route check, delivery, head start ... of one message
    expect(r.calls.hash).toHaveLength(2);
    expect(r.calls.codesign).toHaveLength(2);
  });

  it("checks a file again in full as soon as its identity changes (replaced, rewritten or touched), and only that file", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    r.identity.set(HARNESS, "dev1:ino2:size:mtime:ctime-later");
    verifyAcpRuntime(SERVER, r.deps);
    expect(r.calls.hash).toEqual([SERVER, HARNESS, HARNESS]);
    expect(r.calls.codesign).toEqual([SERVER, HARNESS, HARNESS]);
    r.identity.set(SERVER, "dev1:ino9:size:mtime:ctime");
    verifyAcpRuntime(SERVER, r.deps);
    expect(r.calls.hash).toEqual([SERVER, HARNESS, HARNESS, SERVER]);
  });

  it("a replaced file whose bytes are wrong is refused, and the refusal is not remembered", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    r.identity.set(SERVER, "dev1:ino9:size:mtime:ctime");
    r.digest.set(SERVER, "0".repeat(64));
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("ACP runtime hash mismatch");
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("ACP runtime hash mismatch"); // still refused, hashed again
    expect(r.calls.hash.filter((path) => path === SERVER)).toHaveLength(3);
    r.digest.set(SERVER, ACP_SERVER_SHA);
    verifyAcpRuntime(SERVER, r.deps);
  });

  it("a signature that fails is refused, and is checked again on the next call", () => {
    const r = rig();
    r.sign(false);
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("not signed");
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("not signed");
    expect(r.calls.codesign).toEqual([SERVER, SERVER]);
    r.sign(true);
    verifyAcpRuntime(SERVER, r.deps);
    expect(r.calls.codesign).toEqual([SERVER, SERVER, SERVER, HARNESS]);
  });

  it("a file that is gone is refused even though it passed before", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    r.identity.delete(HARNESS);
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("ENOENT");
  });

  it("what passed at one path never vouches for another path", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    r.identity.set("/other/agy_acp_server.par", "dev1:ino1:size:mtime:ctime"); // the same identity string, another place
    r.identity.set("/other/localharness_external", "dev1:ino2:size:mtime:ctime");
    r.digest.set("/other/agy_acp_server.par", ACP_SERVER_SHA);
    r.digest.set("/other/localharness_external", ACP_HARNESS_SHA);
    verifyAcpRuntime("/other/agy_acp_server.par", r.deps);
    expect(r.calls.hash).toEqual([SERVER, HARNESS, "/other/agy_acp_server.par", "/other/localharness_external"]);
  });

  it("refuses a platform that is not macOS arm64 and a relative command before it touches any file", () => {
    const r = rig();
    expect(() => verifyAcpRuntime(SERVER, { ...r.deps, platform: "linux" })).toThrow("macOS arm64");
    expect(() => verifyAcpRuntime(SERVER, { ...r.deps, arch: "x64" })).toThrow("macOS arm64");
    expect(() => verifyAcpRuntime("agy", r.deps)).toThrow("Verified ACP");
    expect(r.calls.hash).toEqual([]);
  });
});

describe("what a pass vouches for", () => {
  it("a pass for a file as the harness never vouches for the same file as the server (the pinned hash is part of what passed)", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps); // HARNESS passed as the harness
    expect(() => verifyAcpRuntime(HARNESS, r.deps)).toThrow("ACP runtime hash mismatch"); // its bytes are not the server's
    expect(() => verifyAcpRuntime(HARNESS, r.deps)).toThrow("ACP runtime hash mismatch");
  });

  it("an identity taken before the bytes are read is the one remembered: a file replaced while it was hashed is hashed again", () => {
    const r = rig();
    const hash = r.deps.hash;
    r.deps.hash = (path) => { const out = hash(path); if (path === SERVER) r.identity.set(SERVER, "dev1:ino9:size:mtime:ctime-during"); return out; }; // swapped after the read began
    verifyAcpRuntime(SERVER, r.deps);
    r.deps.hash = hash;
    verifyAcpRuntime(SERVER, r.deps);
    expect(r.calls.hash.filter((path) => path === SERVER)).toHaveLength(2);
  });

  it("a refusal forgets the earlier pass: the old identity coming back is hashed again, not trusted", () => {
    const r = rig();
    verifyAcpRuntime(SERVER, r.deps);
    r.identity.set(SERVER, "dev1:ino9:size:mtime:ctime");
    r.digest.set(SERVER, "0".repeat(64));
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("ACP runtime hash mismatch");
    r.identity.set(SERVER, "dev1:ino1:size:mtime:ctime"); // the first identity again
    expect(() => verifyAcpRuntime(SERVER, r.deps)).toThrow("ACP runtime hash mismatch");
  });
});

describe("fileIdentity of a real file", () => {
  const folder = tempDir("agy-identity-");
  const file = join(folder, "runtime");
  const put = (text: string) => writeFileSync(file, text);

  it("is stable while the file is untouched", () => {
    put("aaaa");
    expect(fileIdentity(file)).toBe(fileIdentity(file));
  });

  it("changes when the bytes change with the same size and the old mtime put back (the ctime cannot be put back)", () => {
    const MTIME = 1_700_000_000; // whole seconds: put back exactly, to the nanosecond
    put("aaaa");
    utimesSync(file, MTIME, MTIME);
    const before = fileIdentity(file);
    const wait = Date.now() + 15; while (Date.now() < wait) { /* let the ctime tick */ }
    put("bbbb");
    utimesSync(file, MTIME, MTIME);
    expect(statSync(file).size).toBe(4);
    expect(statSync(file, { bigint: true }).mtimeNs).toBe(BigInt(MTIME) * 1_000_000_000n); // size and mtime are as they were
    expect(fileIdentity(file)).not.toBe(before);
  });

  it("changes when another file is renamed over it", () => {
    put("aaaa");
    const before = fileIdentity(file);
    const other = join(folder, "other");
    writeFileSync(other, "aaaa");
    renameSync(other, file);
    expect(fileIdentity(file)).not.toBe(before);
  });

  it("throws for a file that is not there", () => {
    expect(() => fileIdentity(join(folder, "missing"))).toThrow("ENOENT");
  });
});
