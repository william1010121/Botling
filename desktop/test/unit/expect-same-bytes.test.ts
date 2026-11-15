// expectSameBytes (test/helpers.ts): the fast byte comparison the content tests use instead of toEqual on MiB buffers.
import { describe, expect, it } from "vitest";
import { expectSameBytes } from "../helpers";

describe("expectSameBytes", () => {
  it("passes for equal bytes, also across views with an offset", () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 7, 9);
    expectSameBytes(new Uint8Array(big), Buffer.from(big));
    const backing = Buffer.from([0, 1, 2, 3, 4]);
    expectSameBytes(backing.subarray(1, 4), new Uint8Array([1, 2, 3]));
  });

  it("fails on one changed byte, naming its offset", () => {
    const a = Buffer.alloc(2 * 1024 * 1024, 1), b = Buffer.from(a);
    b[1_500_000] = 2;
    expect(() => expectSameBytes(a, b)).toThrow("first difference at offset 1500000");
  });

  it("fails on a missing or extra tail byte", () => {
    expect(() => expectSameBytes(Buffer.from([1, 2]), Buffer.from([1, 2, 3]))).toThrow("got 2 bytes, expected 3; first difference at offset 2");
    expect(() => expectSameBytes(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toThrow("got 3 bytes, expected 2");
    expect(() => expectSameBytes(new Uint8Array(0), Buffer.from([0]))).toThrow();
  });
});
