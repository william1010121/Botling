// The fetch approval card in the Maintainer's chat, and the fetch grants (§16, D74 Q-C5, M5-06c).
//
// `FetchApproval.ask` is M5-07a's `ask` hook. A fetch that "asks" puts a question card into this server's Maintainer
// chat (`Core.serverAsk`: answered from any device with `chat.choose`, listed in `waiting()`); the pick lets it run once,
// always for what the card shows (a grant row, written by FetchSource after this hook answers) or not at all.
//
// Fail closed everywhere: the only answers that run a fetch are index 0 ("Allow once") and, when the card offers it,
// index 1 ("Always…"). A `null` (card ignored, closed after a restart, core shut down, session gone, timeout), an index
// out of range, a failed write of the pending key, an unreadable folder: all of them are "deny".
//
// Restart: a pending ask is written to `meta` (`fetch:pending:<fetchId>`) BEFORE its card and removed once an answer
// came. At start every pending key becomes `gone` (`fetch:gone:<fetchId>`): the card was closed "No longer needed" by the
// core, so a later `fetch.ask` with that fetchId is refused `gone` ("the source restarted before an answer"), never
// shown a second time (FetchSource asks `gone()` before anything else).
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { RosterView } from "../roster";
import type { Db, ServerStore } from "../store";
import { Limits } from "./policy";
import type { FetchAskHook, FetchAskRequest } from "./source";

/** The `detail` of `fetch.denied{gone}` for an ask that was open when the source restarted (exact). */
export const GONE_DETAIL = "the source restarted before an answer";

const PENDING_PREFIX = "fetch:pending:";
const GONE_PREFIX = "fetch:gone:";
/** How long a `gone` key is kept (a requester asks again within minutes, not weeks). */
const GONE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a card may wait for its answer before it is closed and the fetch is denied. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const NAME_LIMIT = 100;

/** Who and what the card names, by id. A name that is not known is the id itself. */
export interface FetchNames {
  bot(requesterServer: string, botId: string): string | null;
  machine(server: string): string | null;
  device(deviceId: string): string | null;
}

// ---------------------------------------------------------------------------------------------
// The card (texts are user-approved, B-12: byte for byte)

/** One line of text: control characters and line breaks (a peer's words must not fake more card lines) become a space. */
export function oneLine(text: string, limit = 4_096): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, limit);
}

/** `12 MB`: under 1,000,000 bytes `<n> KB` (at least `1 KB`), under 10^9 `<n> MB` (rounded), else `<n.n> GB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export const formatFiles = (files: number): string => (files === 1 ? "1 file" : `${files} files`);

/** The home folder shows as `~` (whole path parts only: `/home/meagain` is not under `/home/me`). */
export function tildePath(path: string, home: string): string {
  if (!home || !isAbsolute(home)) return path;
  const base = home.length > 1 && home.endsWith(sep) ? home.slice(0, -1) : home;
  if (path === base) return "~";
  return path.startsWith(base + sep) ? `~${path.slice(base.length)}` : path;
}

export interface CardInput {
  /** The asking bot's (or device's) name. */
  bot: string;
  /** The machine it asks from. */
  requesterMachine: string;
  /** What the grant would cover (the file, or the folder), as an absolute path on this machine. */
  path: string;
  home: string;
  /** This machine's name. */
  sourceMachine: string;
  bytes: number;
  files: number;
  purpose: string;
  /** M5-07a re-review L-d: the file has other names on disk (nlink > 1). */
  hardLinks?: boolean;
}

/**
 * ```
 * build on studio asks to read ~/src/app on build-box (12 MB, 340 files).
 * Why: <purpose>
 * ```
 * A file with other names on disk gets a third line, `this file has other names on disk`.
 */
export function cardText(input: CardInput): string {
  const lines = [
    `${oneLine(input.bot, NAME_LIMIT)} on ${oneLine(input.requesterMachine, NAME_LIMIT)} asks to read ${oneLine(tildePath(input.path, input.home))} on ${oneLine(input.sourceMachine, NAME_LIMIT)} (${formatSize(input.bytes)}, ${formatFiles(input.files)}).`,
    `Why: ${oneLine(input.purpose, 500)}`,
  ];
  if (input.hardLinks) lines.push("this file has other names on disk");
  return lines.join("\n");
}

/** The three choices (exact); a file with other names on disk is never granted "always", so it offers two. */
export function cardChoices(bot: string, hardLinks: boolean): string[] {
  const name = oneLine(bot, NAME_LIMIT);
  return hardLinks ? ["Allow once", "Deny"] : ["Allow once", `Always for this folder and ${name}`, "Deny"];
}

/**
 * The files and bytes under what was asked (a file is one file; symlinks are not followed, as the source does not follow
 * them), or null past `maxFiles` or when it cannot be read: the ask is then denied without a card.
 */
export async function countTarget(path: string, maxFiles: number): Promise<{ files: number; bytes: number } | null> {
  try {
    const top = await lstat(path);
    if (!top.isDirectory()) return top.isFile() ? { files: 1, bytes: top.size } : null;
    let files = 0;
    let bytes = 0;
    const stack = [path];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.isFile()) continue;
        if (++files > maxFiles) return null;
        bytes += (await lstat(full)).size;
      }
    }
    return { files, bytes };
  } catch {
    return null;
  }
}

/** Names as this cluster knows them (the roster's member names, the replicated `machine` and `bot:<id>` rows). */
export function clusterNames(roster: { readonly view: RosterView }, reader: () => Db): FetchNames {
  const row = (stream: string, key: string): { name?: unknown } | null => {
    try {
      const found = reader().prepare("SELECT body FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(stream, key);
      return found?.body == null ? null : JSON.parse(String(found.body)) as { name?: unknown };
    } catch { return null; }
  };
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    bot: (server, botId) => text(row(`srv:${server}`, `bot:${botId}`)?.name),
    machine: (server) => text(roster.view.members.get(server)?.name) ?? text(row(`srv:${server}`, "machine")?.name),
    device: (deviceId) => text(roster.view.members.get(deviceId)?.name),
  };
}

// ---------------------------------------------------------------------------------------------

/** What `Core.serverAsk` is to this class (the Maintainer's id and the card). */
export interface ApprovalCore {
  readonly maintainerId: string;
  serverAsk(botId: string, ask: { text: string; choices: string[] }, cancelled?: Promise<void>): Promise<number | null>;
}

export interface FetchApprovalOptions {
  core: ApprovalCore;
  store: Pick<ServerStore, "submit">;
  reader(): Db;
  /** This server's id (names the source machine in the card). */
  self: string;
  names?: FetchNames;
  homeDir?: string;
  /** How long a card waits (default 30 minutes), then it is closed "No longer needed" and the fetch is denied. */
  timeoutMs?: number;
  maxFiles?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export interface FetchGrantRow {
  grantId: string;
  requester: string;
  requesterServer: string;
  botName: string;
  machine: string;
  prefix: string;
  kind: "always";
  createdAt: number;
}

export class FetchApproval {
  private readonly gones = new Set<string>();
  /** fetchIds with a card open now (the same fetchId never has two). */
  private readonly open = new Set<string>();
  private readonly names: FetchNames;

  constructor(private readonly options: FetchApprovalOptions) {
    this.names = options.names ?? { bot: () => null, machine: () => null, device: () => null };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private log(line: string): void { this.options.log?.(`fetch approval: ${line}`); }

  /** Start: every pending ask is `gone` from now on (its card was closed by the core's start); old `gone` keys are dropped. */
  async recover(): Promise<void> {
    const at = this.now();
    const ids = await this.options.store.submit((tx) => {
      const keep: string[] = [];
      for (const row of tx.prepare("SELECT key, value FROM meta WHERE key LIKE ? OR key LIKE ?").all(`${PENDING_PREFIX}%`, `${GONE_PREFIX}%`)) {
        const key = String(row.key);
        if (key.startsWith(PENDING_PREFIX)) {
          const id = key.slice(PENDING_PREFIX.length);
          tx.prepare("DELETE FROM meta WHERE key = ?").run(key);
          tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(`${GONE_PREFIX}${id}`, String(at));
          keep.push(id);
          continue;
        }
        const since = Number(row.value);
        if (Number.isFinite(since) && at - since > GONE_KEEP_MS) tx.prepare("DELETE FROM meta WHERE key = ?").run(key);
        else keep.push(key.slice(GONE_PREFIX.length));
      }
      return keep;
    });
    this.gones.clear();
    for (const id of ids) this.gones.add(id);
  }

  /** M5-07a's `gone` option: why a fetchId may not be asked again, or null. */
  gone(fetchId: string): string | null {
    return this.gones.has(fetchId) ? GONE_DETAIL : null;
  }

  /** M5-07a's `ask` option. */
  readonly ask: FetchAskHook = async (fetch, cancelled) => {
    if (this.open.has(fetch.fetchId)) return "deny";
    this.open.add(fetch.fetchId);
    try {
      return await this.askUser(fetch, cancelled);
    } catch (error) {
      this.log(`${fetch.fetchId}: ${(error as Error)?.message ?? String(error)}`);
      return "deny";
    } finally {
      this.open.delete(fetch.fetchId);
    }
  };

  private async askUser(fetch: FetchAskRequest, cancelled: Promise<void>): Promise<"once" | "always" | "deny"> {
    const counted = await countTarget(fetch.realPath, this.options.maxFiles ?? Limits.PER_REQUEST_FILES);
    if (!counted) return "deny";
    const hardLinks = fetch.hardLinks === true;
    const bot = "bot" in fetch.requester
      ? this.names.bot(fetch.requesterServer, fetch.requester.bot) ?? fetch.requester.bot
      : this.names.device(fetch.requester.device) ?? fetch.requester.device;
    // What the user is shown is what a grant covers (M5-07a H1): the asked path itself, never its folder. A file with
    // other names on disk shows the file (its prefix is the whole artifacts folder).
    const shown = hardLinks || !isAbsolute(fetch.prefix) ? fetch.realPath : fetch.prefix;
    const text = cardText({
      bot,
      requesterMachine: this.names.machine(fetch.requesterServer) ?? fetch.requesterServer,
      path: shown,
      home: this.options.homeDir ?? homedir(),
      sourceMachine: this.names.machine(this.options.self) ?? this.options.self,
      bytes: counted.bytes,
      files: counted.files,
      purpose: fetch.purpose,
      hardLinks,
    });
    const key = `${PENDING_PREFIX}${fetch.fetchId}`;
    // Before the card, durably: a restart with the card open must find it.
    await this.options.store.submit((tx) => {
      tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(this.now()));
    });
    const { ended, stop } = this.endOfWait(cancelled);
    let answer: number | null;
    try {
      answer = await this.options.core.serverAsk(this.options.core.maintainerId, { text, choices: cardChoices(bot, hardLinks) }, ended);
    } finally {
      stop();
    }
    // An answer is final: the pending key goes. Without one (ignored, closed, timed out, shut down) it stays, so a restart
    // marks the fetchId `gone` and the card is never shown again for it.
    if (typeof answer !== "number" || !Number.isInteger(answer)) return "deny";
    await this.options.store.submit((tx) => { tx.prepare("DELETE FROM meta WHERE key = ?").run(key); }).catch((error) => this.log(`removing ${key}: ${String((error as Error)?.message ?? error)}`));
    if (answer === 0) return "once";
    if (answer === 1 && !hardLinks) return "always";
    return "deny";
  }

  /** The wait ends when the fetch is over (`cancelled`: session closed, source stopping, a racing resume) or after `timeoutMs`. */
  private endOfWait(cancelled: Promise<void>): { ended: Promise<void>; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      void cancelled.then(resolve);
    });
    return { ended, stop: () => { if (timer) clearTimeout(timer); } };
  }

  /** The "always" grants in force, oldest first (`botlingd fetch grants`). */
  grants(): FetchGrantRow[] {
    const rows = this.options.reader().prepare(
      "SELECT grantId, requester, requesterServer, prefix, createdAt FROM grants WHERE kind = 'always' AND mode = 'read' AND revokedAt IS NULL AND (expires IS NULL OR expires > ?) ORDER BY createdAt, grantId",
    ).all(this.now()) as Array<{ grantId: string; requester: string; requesterServer: string; prefix: string; createdAt: number }>;
    return rows.map((row) => ({
      grantId: String(row.grantId),
      requester: String(row.requester),
      requesterServer: String(row.requesterServer),
      botName: this.names.bot(String(row.requesterServer), String(row.requester)) ?? this.names.device(String(row.requester)) ?? String(row.requester),
      machine: this.names.machine(String(row.requesterServer)) ?? String(row.requesterServer),
      prefix: String(row.prefix),
      kind: "always" as const,
      createdAt: Number(row.createdAt),
    }));
  }

  /** Revokes a grant (once or always); a fetch under it is refused at its next chunk (M5-07a). False when there was nothing to revoke. */
  async revoke(grantId: string): Promise<boolean> {
    const at = this.now();
    return this.options.store.submit((tx) => {
      const result = tx.prepare("UPDATE grants SET revokedAt = ? WHERE grantId = ? AND revokedAt IS NULL").run(at, grantId);
      return Number(result.changes) > 0;
    });
  }
}
