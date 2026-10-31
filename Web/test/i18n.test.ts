/// <reference types="node" />
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { globalItems } from "../src/float";
import { dictionaries, languages, setLanguage, t, type Key } from "../src/i18n";
import { refreshWords, intervalRow } from "../src/refresh";
import { taskChips } from "../src/tasks";
import type { ChatState, MessageView, PinView, StepView } from "../src/types";

// The chat page's own words in the app's two languages: every word in every language, and the
// language the app sends with the state reaching what the page draws.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof IntersectionObserver;

const marks = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
const forms = (word: string | readonly string[]) => (typeof word === "string" ? [word] : [...word]);

describe("the dictionaries", () => {
  const english = dictionaries.en;
  const keys = Object.keys(english) as Key[];

  it("are only English and Traditional Chinese", () => {
    expect([...languages]).toEqual(["en", "zh-Hant"]);
    expect(Object.keys(dictionaries)).toEqual(["en", "zh-Hant"]);
  });

  it("have every word in all two languages, none empty, with the same {marks}", () => {
    expect(keys.length).toBeGreaterThan(0);
    for (const lang of languages) {
      const dictionary = dictionaries[lang];
      expect(Object.keys(dictionary).sort(), lang).toEqual([...keys].sort());
      for (const key of keys) {
        const wanted = new Set(forms(english[key]).flatMap((form) => [...marks(form)]));
        for (const form of forms(dictionary[key])) {
          expect(form.trim(), `${key} in ${lang}`).not.toBe("");
          expect(marks(form), `${key} in ${lang}: "${form}"`).toEqual(wanted);
        }
      }
    }
  });

  it("fill marks and pick English plurals", () => {
    setLanguage("en");
    expect(t("steps.steps", { n: 1 })).toBe("1 step");
    expect(t("steps.steps", { n: 3 })).toBe("3 steps");
    setLanguage("zh-Hant");
    expect(t("steps.steps", { n: 3 })).toBe("3 個步驟");
    // Anything the app does not have is English.
    setLanguage("fr");
    expect(t("steps.worked")).toBe("Worked");
  });
});

describe("the language the app sends", () => {
  function message(id: string, overrides: Partial<MessageView> = {}): MessageView {
    return {
      id, role: "bot", text: "Done", stamp: null, avatar: null,
      choices: null, chosen: null, answer: null, open: false, display: null,
      attachments: null, replyTo: null, replyPreview: null, openable: false,
      ...overrides,
    };
  }
  const step: StepView = { id: "s1", kind: "tool", tool: "Bash", title: "Run swift test", detail: null, output: null, failed: false, done: true, status: null, count: null };
  const state = (lang?: string): ChatState => ({
    botID: "b1", botName: "Bot", messages: [message("m1", { steps: [step, { ...step, id: "s2" }] })], working: false, avatar: "",
    placeholder: "", replyingTo: null, pendingFiles: [], components: {}, lang,
  });
  const toggle = () => document.querySelector("#messages .steps-toggle span")?.textContent;

  beforeAll(async () => {
    document.body.innerHTML = `<main id="scroller"><div id="messages"></div></main><div id="composer-slot"></div>`;
    await import("../src/main");
  });
  afterEach(() => setLanguage("en"));

  it("draws the page's words in it, and again in a new one", () => {
    window.ccb.setState(state("zh-Hant"));
    expect(toggle()).toBe("已處理 · 2 個步驟");
    expect(document.documentElement.lang).toBe("zh-Hant");
    window.ccb.setState(state());
    expect(toggle()).toBe("Worked · 2 steps");
  });
});

describe("menus and rows in Traditional Chinese", () => {
  afterEach(() => setLanguage("en"));

  it("a pin's refresh and float entries, and its interval row with the word before the number", () => {
    setLanguage("zh-Hant");
    expect(refreshWords("interval", 15)).toBe("每 15 分鐘");
    expect(refreshWords("shown", 15)).toBe("顯示時");
    const pin = { id: "p1" } as PinView;
    expect(globalItems({ pin, botName: "garden", global: false, blocked: null })[0].label).toBe("顯示在所有 Bot");
    expect(globalItems({ pin, botName: "garden", global: true, blocked: null })[0].label).toBe("只在 garden");
    const row = intervalRow({ start: { count: 30, unit: "sec" }, set: () => {} }, true);
    const line = row.querySelector(".refresh-interval-line")!;
    expect([...line.children].map((child) => child.className)).toEqual(["refresh-interval-pick", "refresh-interval-count", "refresh-interval-unit"]);
    expect(line.querySelector(".refresh-interval-pick")!.textContent).toBe("每");
    expect(line.querySelector(".refresh-interval-pick")!.getAttribute("aria-label")).toBe("每 30 秒");
    expect([...line.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["秒", "分鐘"]);
  });

  it("the background-work row", () => {
    setLanguage("zh-Hant");
    const now = Date.now();
    const row = taskChips("m1", [{ id: "a", kind: "agent", title: "Review", status: "running", started: now, ended: null, detail: null, message: "m1" }]);
    expect(row.querySelector(".task-summary")!.getAttribute("aria-label")).toBe("背景工作：1 個子代理執行中");
  });
});

