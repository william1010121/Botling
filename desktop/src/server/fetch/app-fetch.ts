// botlingd's side of `app_fetch` (M5-07d, D74 Q-C6): a coordinator names a machine; this resolves it to a valid peer
// server and asks M5-07b's requester for the files, then turns the answer into the one line the bot reads.
//
// - The machine is found only among the cluster's valid servers other than this one, by its name as the roster has it,
//   cleaned the way every name in 3.0 is (`machineName`, the same rule as core/projects.ts `botName`) with its control
//   characters and bidi / zero-width marks escaped (`machineLabel`). A name that no
//   valid peer has, one that two peers have (never guess which machine a file comes from) or one that cleans to nothing
//   is "no machine named".
// - Every name that reaches the text (the one the bot typed, a peer's) is `machineLabel`ed first (L-004): a peer chooses its own
//   name, and the text goes to a model.
// - The text names the folder relative to the bot's folder, built from the last two parts of `dest` (`<source>/<fetchId>`),
//   so no absolute path can get in. A failure's `detail` is never put in (it may name a path of this machine).
// - Fail closed: a requester that is not built yet, or that throws, is "not reachable"; never a stack.
import type { RosterStore } from "../roster";
import type { FetchResult } from "./requester";

/** What the core hands over (core/bot-tools.ts `FetchRequest`, the same shape). */
export interface AppFetchRequest { machine: string; path: string; purpose: string; maxBytes?: number }
const DEFAULT_MAX_BYTES = 524_288_000;

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SPACES = /^[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+|[\t \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
/** A name as one clean line: the first line, no quotes, `@`, `<`, `>` or backtick, trimmed, at most 40 characters (core/projects.ts `botName`, kept equal by a test). */
export function machineName(name: string): string {
  const line = name.split(/\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/).find((piece) => piece.length > 0) ?? "";
  const cleaned = [...line].filter((character) => !"\"@<>`".includes(character)).join("").replace(SPACES, "");
  // Whole characters as a person sees them (an emoji family is one), as botName counts.
  return [...SEGMENTER.segment(cleaned)].slice(0, 40).map((part) => part.segment).join("").replace(SPACES, "");
}

// botName keeps control characters (ESC, BEL, NUL, a tab inside) and the bidi / zero-width marks; a roster name is any
// text up to 100 characters. The rule for text from a peer (code-standards 4, L-004): control characters escaped.
const UNSEEN = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** `machineName`, then every control character and bidi / zero-width mark as `\xNN` / `\uNNNN`: the name the text shows and the match uses. */
export function machineLabel(name: string): string {
  return machineName(name).replace(UNSEEN, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** `12 MB`: under 1,000,000 bytes `<n> KB` (at least `1 KB`), under 10^9 `<n> MB` (rounded), else `<n.n> GB` (the M5-06b rule, bytes). */
function size(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** The line the bot reads for a finished fetch (`name` is already clean). Every reason of `FetchResult` has its text. */
export function fetchResultText(name: string, result: FetchResult): string {
  if (result.ok) {
    const parts = result.dest.split(/[\\/]/).filter(Boolean).slice(-2);
    const files = result.files === 1 ? "1 file" : `${result.files} files`;
    return `Fetched ${files} (${size(result.bytes)}) from ${name} into .bot/incoming/${parts.join("/")}/.`;
  }
  switch (result.reason) {
    // revoked and expired are the source's refusals too (its grant went, or ran out): a "no" to the bot.
    case "denied": case "deny-list": case "outside": case "revoked": case "expired": return `${name} said no.`;
    case "limit": return `${name} stopped the fetch: over the limit (500 MB or 20,000 files per fetch, 2 GB a day per bot).`;
    case "corrupt": return `The files from ${name} arrived damaged; nothing was kept.`;
    case "gone": return `${name} restarted before its user answered; ask again.`;
    case "unreachable": return `${name} is not reachable.`;
  }
  return `${name} is not reachable.`;
}

export interface AppFetchDeps {
  roster: Pick<RosterStore, "view">;
  /** The requester is built after the core; null until then. */
  requester: () => { fetch(botId: string, source: string, what: { kind: "path"; path: string }, purpose: string, maxBytes: number): Promise<FetchResult> } | null;
}

/** The `fetch` option of the core (`CoreOptions.fetch`). */
export function createAppFetch(deps: AppFetchDeps): (botId: string, request: AppFetchRequest) => Promise<string> {
  return async (botId, request) => {
    const wanted = machineLabel(request.machine);
    const view = deps.roster.view;
    const peers = [...view.valid].filter((member) => member !== view.self && view.servers.has(member))
      .filter((member) => wanted !== "" && machineLabel(view.members.get(member)?.name ?? "") === wanted);
    if (peers.length !== 1) return `There is no machine named "${wanted}" in this cluster.`;
    const source = peers[0]!;
    try {
      const requester = deps.requester();
      if (!requester) return fetchResultText(wanted, { ok: false, reason: "unreachable" });
      const result = await requester.fetch(botId, source, { kind: "path", path: request.path }, request.purpose, request.maxBytes ?? DEFAULT_MAX_BYTES);
      return fetchResultText(wanted, result);
    } catch {
      return fetchResultText(wanted, { ok: false, reason: "unreachable" });
    }
  };
}
