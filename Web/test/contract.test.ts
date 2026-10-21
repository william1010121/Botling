/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maxColumns, maxRows, saveLimit, sizeName } from "../src/components";
import { slashQuery } from "../src/composer";
import { shared } from "../src/contract";
import { floatLimits } from "../src/float";
import { isImageURL } from "../src/lightbox";
import { intervalBounds, parseInterval } from "../src/refresh";

describe("the limits shared with Swift (contract.json, written by WebContract.swift)", () => {
  it("are what the page uses", () => {
    expect([maxColumns, maxRows]).toEqual([shared.board.maxColumns, shared.board.maxRows]);
    expect(saveLimit).toBe(shared.saveLimit);
    expect([floatLimits.minWidth, floatLimits.maxWidth]).toEqual(shared.floating.widths);
    expect(intervalBounds.maxSeconds).toBe(shared.refresh.maxSeconds);
    expect(sizeName(3, 1)).toBe(shared.board.sizeNames["3x1"]);
    for (const ext of shared.imageExtensions) expect(isImageURL(`file:///a/b.${ext}`)).toBe(true);
    expect(isImageURL("file:///a/b.html")).toBe(false);
  });

  it("say the longest interval from the bounds", () => {
    const result = parseInterval(String(shared.refresh.maxSeconds / 60 + 1), "min");
    expect("error" in result && result.error).toContain(String(shared.refresh.maxSeconds / 60));
  });

  it("read a /name where Swift does (the shared cases)", () => {
    const cases = JSON.parse(readFileSync(join(__dirname, "fixtures/component-mentions.json"), "utf8")) as { text: string; name: string; found: boolean }[];
    for (const item of cases) {
      const match = slashQuery.exec(item.text);
      expect(match?.[1] === item.name, item.text).toBe(item.found);
    }
  });
});
