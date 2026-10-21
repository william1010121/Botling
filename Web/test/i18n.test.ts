/// <reference types="node" />
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { globalItems } from "../src/float";
import { dictionaries, languages, setLanguage, t, type Key } from "../src/i18n";
import { refreshWords, intervalRow } from "../src/refresh";
import { taskChips } from "../src/tasks";
import type { ChatState, MessageView, PinView, StepView } from "../src/types";

// The chat page's own words in the app's five languages: every word in every language, and the
// language the app sends with the state reaching what the page draws.

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof IntersectionObserver;

const marks = (text: string) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
const forms = (word: string | readonly string[]) => (typeof word === "string" ? [word] : [...word]);

describe("the dictionaries", () => {
  const english = dictionaries.en;
  const keys = Object.keys(english) as Key[];

  it("have every word in all five languages, none empty, with the same {marks}", () => {
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
    setLanguage("ja");
    expect(t("steps.steps", { n: 3 })).toBe("3 ステップ");
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
    window.ccb.setState(state("ja"));
    expect(toggle()).toBe("作業済み · 2 ステップ");
    expect(document.documentElement.lang).toBe("ja");
    window.ccb.setState(state("zh-Hant"));
    expect(toggle()).toBe("已處理 · 2 個步驟");
    window.ccb.setState(state());
    expect(toggle()).toBe("Worked · 2 steps");
  });
});

describe("menus and rows in Japanese", () => {
  afterEach(() => setLanguage("en"));

  it("a pin's refresh and float entries, and its interval row with the number before the words", () => {
    setLanguage("ja");
    expect(refreshWords("interval", 15)).toBe("15 分ごと");
    expect(refreshWords("shown", 15)).toBe("表示されたとき");
    const pin = { id: "p1" } as PinView;
    expect(globalItems({ pin, botName: "garden", global: false, blocked: null })[0].label).toBe("すべてのボットに表示");
    expect(globalItems({ pin, botName: "garden", global: true, blocked: null })[0].label).toBe("garden のみ");
    const row = intervalRow({ start: { count: 30, unit: "sec" }, set: () => {} }, true);
    const line = row.querySelector(".refresh-interval-line")!;
    expect([...line.children].map((child) => child.className)).toEqual(["refresh-interval-count", "refresh-interval-unit", "refresh-interval-pick"]);
    expect(line.querySelector(".refresh-interval-pick")!.textContent).toBe("ごと");
    expect(line.querySelector(".refresh-interval-pick")!.getAttribute("aria-label")).toBe("30 秒ごと");
    expect([...line.querySelectorAll("option")].map((option) => option.textContent)).toEqual(["秒", "分"]);
  });

  it("the background-work row", () => {
    setLanguage("ja");
    const now = Date.now();
    const row = taskChips("m1", [{ id: "a", kind: "agent", title: "Review", status: "running", started: now, ended: null, detail: null, message: "m1" }]);
    expect(row.querySelector(".task-summary")!.getAttribute("aria-label")).toBe("バックグラウンド作業：サブエージェント 1 件実行中");
  });
});

