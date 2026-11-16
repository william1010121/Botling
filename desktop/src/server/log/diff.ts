// The diff format of `entries.body` for snapshot kinds (log-store.ts): RFC 6902 JSON Patch plus two Botling operations.
// It is a storage format of this server's file only; it never goes on a wire, and the hash chain is taken over the whole
// body, so nothing outside log-store.ts sees it.
//
//   add / remove / replace   as in RFC 6902 (array members by index, `add` at the length appends one)
//   append  { path, value }  the string at `path` grows by `value` at its end (a reply text that keeps getting longer)
//   shift   { path, n }      the array at `path` loses its first `n` members (a window like `steps.slice(-500)` moving on)
//
// `diffJson(a, b)` → ops with `applyPatch(a, ops)` equal to `b` (canonical JSON identical); `applyPatch` fails closed:
// any op that does not fit the document throws a `DiffError`, never guesses.
export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "append"; path: string; value: string }
  | { op: "shift"; path: string; n: number };

export class DiffError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffError";
  }
}

const isArray = Array.isArray;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !isArray(value);

/** A string shorter than this is replaced whole instead of `append`ed to (the op's own bytes cost more). */
const APPEND_MIN = 24;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isArray(a)) {
    if (!isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isObject(a)) {
    if (!isObject(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
    return true;
  }
  return false;
}

const escapeKey = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeKey = (key: string): string => key.replace(/~1/g, "/").replace(/~0/g, "~");

/** The ops that turn `a` into `b` (empty when they are equal). Neither argument is changed. */
export function diffJson(a: unknown, b: unknown): PatchOp[] {
  const ops: PatchOp[] = [];
  diffValue(a, b, "", ops);
  return ops;
}

function diffValue(a: unknown, b: unknown, path: string, ops: PatchOp[]): void {
  if (a === b) return;
  if (isArray(a) && isArray(b)) return diffArray(a, b, path, ops);
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) ops.push({ op: "remove", path: `${path}/${escapeKey(key)}` });
    for (const key of Object.keys(b)) {
      const child = `${path}/${escapeKey(key)}`;
      if (!Object.hasOwn(a, key)) ops.push({ op: "add", path: child, value: b[key] });
      else diffValue(a[key], b[key], child, ops);
    }
    return;
  }
  if (typeof a === "string" && typeof b === "string" && a.length >= APPEND_MIN && b.length > a.length && b.startsWith(a)) {
    ops.push({ op: "append", path, value: b.slice(a.length) });
    return;
  }
  ops.push({ op: "replace", path, value: b });
}

function diffArray(a: unknown[], b: unknown[], path: string, ops: PatchOp[]): void {
  let cur = a;
  // A window that moved on: dropping the first n members of `a` leaves a prefix of `b`.
  if (a.length > 1 && b.length > 0 && !deepEqual(a[0], b[0])) {
    for (let n = 1; n < a.length; n++) {
      if (!deepEqual(a[n], b[0])) continue;
      const rest = a.length - n;
      if (rest > b.length) continue;
      let same = true;
      for (let i = 1; i < rest && same; i++) same = deepEqual(a[n + i], b[i]);
      if (!same) continue;
      ops.push({ op: "shift", path, n });
      cur = a.slice(n);
      break;
    }
  }
  const common = Math.min(cur.length, b.length);
  for (let i = 0; i < common; i++) diffValue(cur[i], b[i], `${path}/${i}`, ops);
  for (let i = cur.length - 1; i >= b.length; i--) ops.push({ op: "remove", path: `${path}/${i}` });
  for (let i = cur.length; i < b.length; i++) ops.push({ op: "add", path: `${path}/${i}`, value: b[i] });
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty: `target["__proto__"] = x` would change the prototype instead of adding a member.
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function index(segment: string, length: number, allowEnd: boolean): number {
  if (!/^(0|[1-9][0-9]{0,15})$/.test(segment)) throw new DiffError(`bad array index ${JSON.stringify(segment)}`);
  const at = Number(segment);
  if (at > length || (at === length && !allowEnd)) throw new DiffError(`array index ${at} is out of range (length ${length})`);
  return at;
}

function walk(root: unknown, segments: string[]): unknown {
  let node = root;
  for (const segment of segments) {
    if (isArray(node)) node = node[index(segment, node.length, false)];
    else if (isObject(node) && Object.hasOwn(node, segment)) node = node[segment];
    else throw new DiffError(`no member ${JSON.stringify(segment)}`);
  }
  return node;
}

function parsePath(path: unknown): string[] {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/"))) throw new DiffError("bad path");
  return path === "" ? [] : path.slice(1).split("/").map(unescapeKey);
}

/** Applies `ops` to `doc` in order. `doc` is changed in place where it can be; use the returned document. Throws `DiffError`. */
export function applyPatch(doc: unknown, ops: unknown): unknown {
  if (!isArray(ops)) throw new DiffError("a patch is an array of ops");
  let root = doc;
  for (const raw of ops) {
    if (!isObject(raw) || typeof raw.op !== "string") throw new DiffError("bad op");
    const segments = parsePath(raw.path);
    const hasValue = Object.hasOwn(raw, "value");
    if (segments.length === 0) {
      if (raw.op === "replace" && hasValue) { root = raw.value; continue; }
      if (raw.op === "append" && typeof raw.value === "string" && typeof root === "string") { root += raw.value; continue; }
      if (raw.op === "shift" && isArray(root)) { shift(root, raw.n); continue; }
      throw new DiffError(`op ${raw.op} is not valid at the root`);
    }
    const last = segments[segments.length - 1];
    const parent = walk(root, segments.slice(0, -1));
    switch (raw.op) {
      case "add":
        if (!hasValue) throw new DiffError("add needs a value");
        if (isArray(parent)) parent.splice(index(last, parent.length, true), 0, raw.value);
        else if (isObject(parent) && !Object.hasOwn(parent, last)) setOwn(parent, last, raw.value);
        else throw new DiffError(`cannot add ${JSON.stringify(last)}`);
        break;
      case "remove":
        if (isArray(parent)) parent.splice(index(last, parent.length, false), 1);
        else if (isObject(parent) && Object.hasOwn(parent, last)) delete parent[last];
        else throw new DiffError(`cannot remove ${JSON.stringify(last)}`);
        break;
      case "replace":
        if (!hasValue) throw new DiffError("replace needs a value");
        if (isArray(parent)) parent[index(last, parent.length, false)] = raw.value;
        else if (isObject(parent) && Object.hasOwn(parent, last)) setOwn(parent, last, raw.value);
        else throw new DiffError(`cannot replace ${JSON.stringify(last)}`);
        break;
      case "append": {
        if (typeof raw.value !== "string") throw new DiffError("append needs a string value");
        const current = walk(parent, [last]);
        if (typeof current !== "string") throw new DiffError("append needs a string target");
        if (isArray(parent)) parent[Number(last)] = current + raw.value;
        else setOwn(parent as Record<string, unknown>, last, current + raw.value);
        break;
      }
      case "shift": {
        const target = walk(parent, [last]);
        if (!isArray(target)) throw new DiffError("shift needs an array target");
        shift(target, raw.n);
        break;
      }
      default:
        throw new DiffError(`unknown op ${raw.op}`);
    }
  }
  return root;
}

function shift(target: unknown[], n: unknown): void {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > target.length) throw new DiffError("bad shift count");
  target.splice(0, n);
}
