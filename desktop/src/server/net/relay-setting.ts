// botlingd's durable relay address (the Botling 3 phone page on the relay): `<data>/relay.json` = `{"url":"wss://…/ws"}`.
// It turns the relay path on without an environment variable, so the packaged app (started from Finder) uses it too.
//
// - Written by `botlingd relay set <url>` / `botlingd relay clear` and by the 2.x import (only the 2.x address, never
//   its room or identity keys). It takes effect at botlingd's next start.
// - `BOTLING_SERVER_RELAY_URL`, when set, wins (tests and development; "off" turns the relay off).
// - Address rules are the 2.x ones (mobile-relay/store.ts `relayURL`): wss:// anywhere, ws:// only to this machine,
//   the path `/ws` (a bare host gets it), no credentials, query or fragment.
// - Symlink-safe (L-002): written through a temporary file beside it and one rename (core/durable/atomic.ts), which
//   replaces a link rather than following it; read with O_NOFOLLOW and required to be a small regular file.
// - Fail closed (L-009): a file that cannot be read or does not parse leaves the relay off and is logged by name only.
import { closeSync, constants, fstatSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../core/durable/atomic";
import { RELAY_URL_ENV, relayUrl } from "./relay";

/** The setting's file in botlingd's data folder. */
export const RELAY_SETTING_FILE = "relay.json";
/** The file is one short JSON object; anything bigger is not ours. */
const MAX_SETTING_BYTES = 4_096;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class RelaySettingError extends Error {
  constructor(message: string) { super(message); this.name = "RelaySettingError"; }
}

const Setting = z.strictObject({ url: z.string().min(1).max(300) });

/** A relay address botlingd may keep (the 2.x rules); throws RelaySettingError with what to type instead. */
export function relaySettingUrl(input: string): string {
  const fail = (): never => {
    throw new RelaySettingError("Use a wss:// relay address ending in /ws (ws:// only for localhost), without credentials, query or fragment.");
  };
  let url: URL;
  try { url = new URL(input.trim()); } catch { return fail(); }
  const local = LOOPBACK.has(url.hostname);
  if (!(url.protocol === "wss:" || (url.protocol === "ws:" && local))) fail();
  if (url.username || url.password || url.search || url.hash || input.includes("#") || input.includes("?")) fail();
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  if (url.pathname !== "/ws") fail();
  return url.href;
}

/** The kept address, or null when there is none. Throws RelaySettingError when the file is not a valid setting. */
export function readRelaySetting(dataDir: string): string | null {
  const file = join(dataDir, RELAY_SETTING_FILE);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RelaySettingError(`${RELAY_SETTING_FILE} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new RelaySettingError(`${RELAY_SETTING_FILE} is not a regular file.`);
    if (stat.size > MAX_SETTING_BYTES) throw new RelaySettingError(`${RELAY_SETTING_FILE} is larger than ${MAX_SETTING_BYTES} bytes.`);
    text = readFileSync(fd, "utf8");
  } catch (error) {
    if (error instanceof RelaySettingError) throw error;
    throw new RelaySettingError(`${RELAY_SETTING_FILE} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
  } finally {
    closeSync(fd);
  }
  if (Buffer.byteLength(text) > MAX_SETTING_BYTES) throw new RelaySettingError(`${RELAY_SETTING_FILE} is larger than ${MAX_SETTING_BYTES} bytes.`);
  let parsed: z.infer<typeof Setting>;
  try { parsed = Setting.parse(JSON.parse(text)); } catch { throw new RelaySettingError(`${RELAY_SETTING_FILE} is not {"url": "wss://…/ws"}.`); }
  let url: string;
  try { url = relaySettingUrl(parsed.url); } catch { throw new RelaySettingError(`${RELAY_SETTING_FILE} holds an address that is not wss://…/ws.`); }
  if (url !== parsed.url) throw new RelaySettingError(`${RELAY_SETTING_FILE} holds an address that is not in its plain form.`);
  return url;
}

/** Keeps `url` (checked first; nothing is written for a bad one), or removes the setting for null. */
export function writeRelaySetting(dataDir: string, url: string | null): void {
  const file = join(dataDir, RELAY_SETTING_FILE);
  if (url === null) { rmSync(file, { force: true }); return; }
  const clean = relaySettingUrl(url);
  writeFileAtomic(file, `${JSON.stringify({ url: clean })}\n`);
}

export type RelaySource = "env" | "file" | "off";

/**
 * The relay address botlingd uses: `BOTLING_SERVER_RELAY_URL` when set (throws on a malformed one, as before), else the
 * kept setting, else off. A setting that cannot be read is logged (its name, never its contents) and leaves the relay off.
 */
export function effectiveRelayUrl(
  env: Record<string, string | undefined>,
  dataDir: string,
  log?: (line: string) => void,
): { url: string | null; source: RelaySource } {
  if ((env[RELAY_URL_ENV] ?? "").trim() !== "") return { url: relayUrl(env), source: "env" };
  try {
    const url = readRelaySetting(dataDir);
    return url ? { url, source: "file" } : { url: null, source: "off" };
  } catch (error) {
    log?.(`relay: off, ${error instanceof RelaySettingError ? error.message : `${RELAY_SETTING_FILE} cannot be read`} (botlingd relay set <url> writes it again)`);
    return { url: null, source: "off" };
  }
}
