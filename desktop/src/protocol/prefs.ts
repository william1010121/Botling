// Botling 3 wire protocol v1: cluster preferences (protocol-v1.md §17, §4.7). The only multi-writer state besides the
// roster: language, theme, report theme, reply language, default models, followed bots, the designated server. Each key
// is a last-writer-wins register ordered by `(hlc, writer)`; servers gossip them like the roster:
// `prefs.have{digest}` at session start, on a mismatch `prefs.ids` → `prefs.want` → `prefs.rows`; new rows are pushed.
import { z } from "zod";
import { canonicalJson } from "./entries";
import { sha256, toHex, utf8Bytes } from "./encoding";
import { EntryHash, Hlc, ServerId } from "./ids";

/** The most a preference value's canonical JSON may be. */
export const PREF_VALUE_CHARS = 16_000;
/** At most this many keys or rows in one `prefs.*` frame. */
export const PREFS_LIMIT = 500;

/** A preference key, e.g. `language`, `followedBots`, `designatedServer`. */
export const PrefKey = z.string().min(1).max(64).regex(/^[a-z][A-Za-z0-9_.-]*$/);
/** Which write of a key wins: the larger `(hlc.ms, hlc.c, writer)`. `writer` is the server that took the write. */
export const PrefVersion = z.strictObject({ key: PrefKey, hlc: Hlc, writer: ServerId });
export type PrefVersion = z.infer<typeof PrefVersion>;
/** One register: its value (any JSON; null clears it) and its version. */
export const PrefRow = z.strictObject({
  key: PrefKey,
  value: z.unknown().refine((value) => {
    if (value === undefined) return false;
    try { return canonicalJson(value).length <= PREF_VALUE_CHARS; } catch { return false; }
  }, { message: `a JSON value of at most ${PREF_VALUE_CHARS} characters` }),
  hlc: Hlc,
  writer: ServerId,
});
export type PrefRow = z.infer<typeof PrefRow>;

const uniqueKeys = (items: readonly ({ key: string } | string)[]) => new Set(items.map((item) => (typeof item === "string" ? item : item.key))).size === items.length;
const msg = <T extends string, S extends z.core.$ZodLooseShape>(t: T, shape: S) => z.strictObject({ t: z.literal(t), ...shape });

export const PrefsHave = msg("prefs.have", { digest: EntryHash });
export const PrefsIds = msg("prefs.ids", { versions: z.array(PrefVersion).max(PREFS_LIMIT).refine(uniqueKeys, { message: "a key is listed once" }) });
export const PrefsWant = msg("prefs.want", { keys: z.array(PrefKey).max(PREFS_LIMIT).refine(uniqueKeys, { message: "a key is listed once" }) });
export const PrefsRows = msg("prefs.rows", { rows: z.array(PrefRow).max(PREFS_LIMIT).refine(uniqueKeys, { message: "a key is listed once" }) });

/** Orders two versions of a key: negative when `a` loses to `b`, 0 when they are the same write. */
export function comparePrefVersions(a: Pick<PrefVersion, "hlc" | "writer">, b: Pick<PrefVersion, "hlc" | "writer">): number {
  if (a.hlc.ms !== b.hlc.ms) return a.hlc.ms < b.hlc.ms ? -1 : 1;
  if (a.hlc.c !== b.hlc.c) return a.hlc.c < b.hlc.c ? -1 : 1;
  return a.writer === b.writer ? 0 : a.writer < b.writer ? -1 : 1;
}

/** Merges `incoming` into `held` (one row per key), keeping each key's winner. Order and duplicates do not matter. */
export function mergePrefs(held: Iterable<PrefRow>, incoming: Iterable<PrefRow>): Map<string, PrefRow> {
  const out = new Map<string, PrefRow>();
  for (const row of [...held, ...incoming]) {
    const current = out.get(row.key);
    if (!current || comparePrefVersions(current, row) < 0) out.set(row.key, row);
  }
  return out;
}

/** The preferences digest (`prefs.have`): SHA-256 of the canonical JSON of every key's version, sorted by key. */
export async function prefsDigest(versions: Iterable<Pick<PrefVersion, "key" | "hlc" | "writer">>): Promise<string> {
  const sorted = [...versions].map(({ key, hlc, writer }) => [key, hlc.ms, hlc.c, writer] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return toHex(await sha256(utf8Bytes(`botling/3 prefs v1\n${canonicalJson(sorted)}`)));
}
