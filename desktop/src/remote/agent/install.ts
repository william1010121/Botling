// botling-agent installing itself (multi-machine phase 1, M3): `botling-agent install` puts the running bundle and
// its launcher under ~/.botling-agent (the install script runs it after checking the download), and the `upgrade`
// request over the relay fetches the GitHub release of Botling's version, checks it against the SHA-256 Botling sent
// over the end-to-end channel (Botling's own bundle is that same file), and replaces the agent with it.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_RELEASES, LAUNCHER, agentAsset } from "../protocol";

const MAX_BUNDLE = 32 * 1024 * 1024;
export const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
export const SHA_RE = /^[0-9a-f]{64}$/;

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Writes the bundle and the launcher into <home> (each atomically). */
export function installBundle(home: string, bundle: Buffer) {
  mkdirSync(join(home, "lib"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "bin"), { recursive: true, mode: 0o700 });
  const lib = join(home, "lib", "botling-agent.cjs"), bin = join(home, "bin", "botling-agent");
  writeFileSync(`${lib}.new`, bundle, { mode: 0o600 });
  renameSync(`${lib}.new`, lib);
  writeFileSync(`${bin}.new`, LAUNCHER, { mode: 0o700 });
  chmodSync(`${bin}.new`, 0o700);
  renameSync(`${bin}.new`, bin);
}

/** The release's address for a version (BOTLING_AGENT_RELEASES points elsewhere, e.g. a mirror or a test server). */
export function releaseURL(version: string): string {
  const base = (process.env.BOTLING_AGENT_RELEASES?.trim() || AGENT_RELEASES).replace(/\/+$/, "");
  return `${base}/v${version}/${agentAsset(version)}`;
}

/** Downloads the agent of `version` and checks it is exactly the file whose SHA-256 is `sha`. */
export async function downloadAgent(version: string, sha: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!VERSION_RE.test(version)) throw new Error("Not a version.");
  if (!SHA_RE.test(sha)) throw new Error("Not a SHA-256.");
  const url = releaseURL(version);
  const response = await fetchImpl(url, { redirect: "follow", headers: { "User-Agent": "botling-agent" } });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BUNDLE) throw new Error("The download is too large to be botling-agent.");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_BUNDLE) throw new Error("The download is too large to be botling-agent.");
  const got = sha256(data);
  if (got !== sha) throw new Error(`The downloaded botling-agent ${version} is not the one Botling runs (SHA-256 ${got.slice(0, 12)}…, expected ${sha.slice(0, 12)}…). Nothing was installed.`);
  return data;
}

/** The `upgrade` request: download, check, install. `restart` runs once the answer went out (the daemon restarts). */
export async function upgradeAgent(home: string, args: Record<string, unknown>, ownSha: string, fetchImpl?: typeof fetch): Promise<{ installed: boolean; sha: string }> {
  const version = String(args.version ?? ""), sha = String(args.sha ?? "");
  if (!VERSION_RE.test(version) || !SHA_RE.test(sha)) throw new Error("The upgrade request needs a version and a SHA-256.");
  if (sha === ownSha) return { installed: false, sha };
  const bundle = await downloadAgent(version, sha, fetchImpl);
  installBundle(home, bundle);
  return { installed: true, sha };
}

/** The `upgrade` request handler of one agent process: a second request for what it installed already only waits for the restart. */
export function agentUpgrader(home: string, ownSha: string, fetchImpl?: typeof fetch) {
  let installed = "";
  return async (args: Record<string, unknown>): Promise<{ installed: boolean; sha: string; restarting?: boolean }> => {
    const sha = String(args.sha ?? "");
    if (installed && sha === installed) return { installed: false, sha, restarting: true };
    const result = await upgradeAgent(home, args, ownSha, fetchImpl);
    if (result.installed) installed = result.sha;
    return result;
  };
}
