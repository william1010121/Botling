// The diff format of entries.body (src/server/log/diff.ts): RFC 6902 plus `append` and `shift`; round trips, the ops each
// kind of change makes, and that a patch which does not fit its document is refused, never guessed.
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/protocol";
import { applyPatch, DiffError, diffJson } from "../../src/server/log/diff";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function roundTrip(a: unknown, b: unknown) {
  const ops = diffJson(a, b);
  const before = canonicalJson(a);
  const out = applyPatch(clone(a), JSON.parse(JSON.stringify(ops)));
  expect(canonicalJson(out)).toBe(canonicalJson(b));
  expect(canonicalJson(a)).toBe(before); // diffJson does not touch its inputs
  return ops;
}

describe("diffJson / applyPatch", () => {
  it("equal values make no ops", () => {
    expect(roundTrip({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toEqual([]);
  });

  it("changes, additions and removals of members", () => {
    const ops = roundTrip({ a: 1, b: 2, c: { d: 3 } }, { a: 1, c: { d: 4, e: 5 }, f: null });
    expect(ops).toEqual([
      { op: "remove", path: "/b" },
      { op: "replace", path: "/c/d", value: 4 },
      { op: "add", path: "/c/e", value: 5 },
      { op: "add", path: "/f", value: null },
    ]);
  });

  it("a string that only grew at its end is an append; a short one or a rewrite is a replace", () => {
    const long = "the quick brown fox jumps over the lazy dog";
    expect(roundTrip({ t: long }, { t: `${long} and on` })).toEqual([{ op: "append", path: "/t", value: " and on" }]);
    expect(roundTrip({ t: "abc" }, { t: "abcdef" })).toEqual([{ op: "replace", path: "/t", value: "abcdef" }]);
    expect(roundTrip({ t: long }, { t: `X${long}` })[0]).toMatchObject({ op: "replace" });
  });

  it("a window that moved on is a shift, then the new tail is added", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, text: `step ${i}` }));
    const ops = roundTrip({ steps: rows }, { steps: [...rows.slice(3), { id: "s10", text: "step 10" }, { id: "s11", text: "step 11" }] });
    expect(ops[0]).toEqual({ op: "shift", path: "/steps", n: 3 });
    expect(ops.slice(1)).toEqual([
      { op: "add", path: "/steps/7", value: { id: "s10", text: "step 10" } },
      { op: "add", path: "/steps/8", value: { id: "s11", text: "step 11" } },
    ]);
    // a shift that also changes a kept member
    const changed = [...rows.slice(2)];
    changed[1] = { id: "s3", text: "step 3 (edited)" };
    expect(roundTrip({ steps: rows }, { steps: changed }).some((op) => op.op === "shift")).toBe(true);
  });

  it("arrays that shrink remove from the end; type changes and the root are replaced", () => {
    expect(roundTrip({ a: [1, 2, 3, 4] }, { a: [1, 2] })).toEqual([{ op: "remove", path: "/a/3" }, { op: "remove", path: "/a/2" }]);
    roundTrip({ a: [1, 2] }, { a: { x: 1 } });
    roundTrip({ a: null }, { a: [] });
    roundTrip(1, 2);
    roundTrip({ a: 1 }, [1]);
  });

  it("keys with / and ~ and members named like Object.prototype ones survive", () => {
    const a = JSON.parse('{"a/b":1,"~":2,"__proto__":{"x":1},"constructor":3}') as unknown;
    const b = JSON.parse('{"a/b":5,"~":2,"__proto__":{"x":2},"toString":4}') as unknown;
    roundTrip(a, b);
    const out = applyPatch(clone({}), [{ op: "add", path: "/__proto__", value: { polluted: true } }]) as Record<string, unknown>;
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("random edits round trip", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const make = (depth: number): unknown => {
      const kind = rand(depth > 2 ? 4 : 7);
      if (kind === 0) return rand(100);
      if (kind === 1) return `s${rand(50)}`.repeat(1 + rand(8));
      if (kind === 2) return null;
      if (kind === 3) return rand(2) === 0;
      if (kind === 4 || kind === 5) return Array.from({ length: rand(6) }, () => make(depth + 1));
      return Object.fromEntries(Array.from({ length: rand(5) }, (_, i) => [`k${rand(6)}_${i % 3}`, make(depth + 1)]));
    };
    const mutate = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        const out = value.map((item) => (rand(3) === 0 ? mutate(item) : item));
        if (rand(3) === 0) out.splice(0, rand(out.length + 1));
        if (rand(3) === 0) out.push(make(2));
        return out;
      }
      if (value && typeof value === "object") {
        const out = { ...(value as Record<string, unknown>) };
        for (const key of Object.keys(out)) { if (rand(4) === 0) delete out[key]; else if (rand(3) === 0) out[key] = mutate(out[key]); }
        if (rand(3) === 0) out[`n${rand(9)}`] = make(2);
        return out;
      }
      if (typeof value === "string" && rand(2) === 0) return `${value} and some more text that was appended`;
      return rand(4) === 0 ? make(2) : value;
    };
    for (let run = 0; run < 400; run++) {
      const a = { root: make(0), list: Array.from({ length: rand(12) }, (_, i) => ({ id: i, v: make(2) })) };
      roundTrip(a, mutate(a));
    }
  });
});

describe("applyPatch fails closed", () => {
  const bad: Array<[string, unknown]> = [
    ["not an array", { op: "add" }],
    ["unknown op", [{ op: "move", path: "/a", value: 1 }]],
    ["missing member", [{ op: "replace", path: "/zzz", value: 1 }]],
    ["remove of a missing member", [{ op: "remove", path: "/zzz" }]],
    ["add over an existing member", [{ op: "add", path: "/a", value: 1 }]],
    ["array index out of range", [{ op: "replace", path: "/l/9", value: 1 }]],
    ["array index that is not a number", [{ op: "replace", path: "/l/x", value: 1 }]],
    ["array index with leading zero", [{ op: "replace", path: "/l/01", value: 1 }]],
    ["append to a number", [{ op: "append", path: "/a", value: "x" }]],
    ["append of a non-string", [{ op: "append", path: "/s", value: 1 }]],
    ["shift of a non-array", [{ op: "shift", path: "/a", n: 1 }]],
    ["shift by too many", [{ op: "shift", path: "/l", n: 4 }]],
    ["shift by zero", [{ op: "shift", path: "/l", n: 0 }]],
    ["path without a slash", [{ op: "replace", path: "a", value: 1 }]],
    ["replace without a value", [{ op: "replace", path: "/a" }]],
    ["an op that is not an object", [7]],
  ];
  for (const [name, ops] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => applyPatch({ a: 1, s: "text", l: [1, 2, 3] }, ops)).toThrow(DiffError);
    });
  }
});
