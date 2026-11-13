// Which copy of a plugin runs when both Botling and the plugin library have one of the same name (registry.ts `rescan`).
//
// The rule: the library copy runs when its version is the SAME as or NEWER than the built-in one's (semver precedence,
// pre-releases included: 1.20.0-dev is newer than 1.19.0, 1.19.0-dev is older than 1.19.0, build metadata after "+" is
// ignored). Otherwise, and whenever either version is not a semver (nothing proves the library copy is newer), the
// built-in copy runs and the library copy is ignored, which the Plugins page says. So a user whose library holds an old
// copy (Maintainer copied a built-in plugin once, or it was built in later, as botling.note in 2.7.0) gets the newer one
// Botling ships, while a developer's library copy at the built-in's version or above still overrides it, as before.

type Parsed = { core: [number, number, number]; pre: string[] };

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parse(version: string): Parsed | null {
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (!core.every(Number.isSafeInteger)) return null;
  return { core, pre: match[4] ? match[4].split(".") : [] };
}

/** Pre-release identifiers: numbers below words, numbers by value, words by ASCII; a longer list is above its own prefix. */
function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return (b.length ? 1 : 0) - (a.length ? 1 : 0); // a release is above any of its pre-releases
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i]!, y = b[i]!;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = Number(x) - Number(y); if (d) return Math.sign(d); continue; }
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver precedence of two versions: -1, 0 or 1; null when either is not a semver (such as "1.2", "v1.2.3" or "1.2.3.4"). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  return comparePre(x.pre, y.pre) as -1 | 0 | 1;
}

/** Whether a library copy at `library` runs in place of the built-in plugin at `builtIn` (the rule above). */
export function libraryCopyWins(library: string, builtIn: string): boolean {
  const order = compareVersions(library, builtIn);
  return order !== null && order >= 0;
}
