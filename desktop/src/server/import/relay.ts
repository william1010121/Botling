// The 2.x phone relay's address, carried into botlingd's relay setting (server/net/relay-setting.ts) by the import.
//
// - Reads only `url` from 2.x `<data>/mobile/relay.json`. That file also holds the 2.x room key and identity private
//   key; they are never copied, reported or logged (L-015). A 2.x room is not a Botling 3 room: botlingd makes its own.
// - Read-only and symlink-safe (L-002): the `mobile` folder must be a real folder inside the source, the file is opened
//   with O_NOFOLLOW and must be a small regular file.
// - A relay already set in Botling 3 is kept (the user's newer choice); a 2.x address that is not a plain wss://…/ws
//   one is not carried and becomes a problem line (without the address, which could hold credentials).
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRelaySetting, relaySettingUrl } from "../net/relay-setting";

const MAX_2X_RELAY_BYTES = 64 * 1024;

export interface RelayImportPlan {
  /** The address to keep for botlingd, or null when nothing is written. */
  write: string | null;
  /** The report's line, or null when 2.x had no relay. */
  line: string | null;
  problem: string | null;
}

/** The 2.x relay address, null when 2.x had none or it was off; throws on a file that is not a readable relay.json. */
function read2xRelayUrl(sourceReal: string): string | null {
  const dir = join(sourceReal, "mobile");
  let dirStat;
  try { dirStat = lstatSync(dir); } catch { return null; }
  if (!dirStat.isDirectory()) throw new Error("the 2.x mobile folder is not a folder");
  let fd: number;
  try {
    fd = openSync(join(dir, "relay.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`the 2.x relay.json cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_2X_RELAY_BYTES) throw new Error("the 2.x relay.json is not a small regular file");
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("the 2.x relay.json is not JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.hasOwn(parsed, "url")) return null;
  const url = (parsed as { url: unknown }).url;
  if (url === null) return null;
  if (typeof url !== "string") throw new Error("the 2.x relay address is not text");
  return url;
}

/** What the import does with the 2.x relay address for the target `targetDir` (nothing is written here). */
export function planRelayImport(sourceReal: string, targetDir: string, dryRun: boolean): RelayImportPlan {
  let raw: string | null;
  try {
    raw = read2xRelayUrl(sourceReal);
  } catch (error) {
    return { write: null, line: null, problem: `phone relay: not carried (${(error as Error).message})` };
  }
  if (raw === null) return { write: null, line: null, problem: null };
  let url: string;
  try {
    url = relaySettingUrl(raw);
  } catch {
    return { write: null, line: null, problem: "phone relay: not carried (the 2.x address is not a plain wss://…/ws address; set one with botlingd relay set <url>)" };
  }
  let existing: string | null;
  try {
    existing = readRelaySetting(targetDir);
  } catch {
    return { write: null, line: null, problem: "phone relay: not carried (Botling 3's relay.json cannot be read; set it with botlingd relay set <url>)" };
  }
  if (existing !== null) {
    return { write: null, line: existing === url ? `Phone relay: ${existing} (already set)` : `Phone relay: ${existing} (already set; 2.x had ${url})`, problem: null };
  }
  return { write: dryRun ? null : url, line: `Phone relay: ${url} (${dryRun ? "would be set" : "set"}; botlingd uses it at its next start)`, problem: null };
}
