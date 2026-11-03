// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../../../../Web/src/i18n";
import { shared } from "../../../../Web/src/contract";
import type { PinView } from "../../../../Web/src/types";
import { floatLimits, globalItems } from "../src/float";
import { installBoard } from "./support";
import { own, ownWords } from "../src/words";

const marks = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
const forms = (word: string | readonly string[]) => (typeof word === "string" ? [word] : [...word]);

beforeEach(() => installBoard());
afterEach(() => { setLanguage("en"); document.documentElement.lang = "en"; });

describe("the Board's words", () => {
  it("are in both languages, none empty, with the same {marks}", () => {
    const { en, zhHant } = ownWords;
    expect(Object.keys(zhHant).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const wanted = new Set(forms(en[key]).flatMap((form) => [...marks(form)]));
      for (const form of forms(zhHant[key])) {
        expect(form.trim(), key).not.toBe("");
        expect(marks(form), `${key}: "${form}"`).toEqual(wanted);
      }
    }
  });

  it("follow the page's language, fill marks and pick English plurals", () => {
    expect(own("pins.pinned")).toBe("Pinned");
    expect(own("pins.uses", { n: 1 })).toBe("1 use");
    expect(own("pins.uses", { n: 3 })).toBe("3 uses");
    document.documentElement.lang = "zh-Hant";
    expect(own("pins.pinToBotMenu", { bot: "garden" })).toBe("釘選到 garden…");
  });

  it("a pin's float entry in Traditional Chinese", () => {
    setLanguage("zh-Hant");
    document.documentElement.lang = "zh-Hant";
    const pin = { id: "p1" } as PinView;
    expect(globalItems({ pin, botName: "garden", global: false, blocked: null })[0].label).toBe("顯示在所有 Bot");
    expect(globalItems({ pin, botName: "garden", global: true, blocked: null })[0].label).toBe("只在 garden");
  });
});

describe("the limits shared with Swift (contract.json)", () => {
  it("are what the floating cards use", () => {
    expect([floatLimits.minWidth, floatLimits.maxWidth]).toEqual(shared.floating.widths);
  });
});
