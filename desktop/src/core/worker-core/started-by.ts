// M7-O03b: who started a worker, when a plugin did (the plugin's name and the hash of what it was when it asked).
// The ledger record keeps it (`startedBy`, optional: a ledger without it reads as it always did), the worker's name in
// the user's lists shows it, and every message a plugin sends into the worker starts with a line that says it.

/** A plugin that started a worker: its name and the hash of its manifest at that time. */
export interface StartedBy { plugin: string; hash: string }

const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();

/** A valid mark, or null: strings of a sane shape, never an object from a file taken as it stands. */
export function readStartedBy(value: unknown): StartedBy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { plugin, hash } = value as Record<string, unknown>;
  if (typeof plugin !== "string" || typeof hash !== "string") return null;
  const name = oneLine(plugin).slice(0, 200);
  return name && /^[0-9a-f]{8,128}$/.test(hash) ? { plugin: name, hash } : null;
}

/** The short form: the name and the first 8 characters of the hash. */
const shortOf = (by: StartedBy) => `${by.plugin} (${by.hash.slice(0, 8)})`;

/** The name the user sees: the worker's own name, and which plugin started it (a worker nobody's plugin started: unchanged). */
export const shownName = (r: { name: string; startedBy?: StartedBy }) => (r.startedBy ? `${r.name} · plugin ${shortOf(r.startedBy)}` : r.name);

/** The line before a message a plugin sends into a worker: its full hash, so the message can be traced. */
export const startedByLine = (by: StartedBy) => `[Sent by the plugin ${JSON.stringify(oneLine(by.plugin))}, hash ${by.hash}, not by the user.]`;
