/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../src/bridge";
import { Composer } from "../src/composer";
import { componentPage } from "../src/components";
import { compositionGrace, imeGuardScript, installImeGuard, isComposingEnter } from "../src/ime";
import { SpecPanel } from "../src/spec";
import type { ChatState, SpecState } from "../src/types";

// CodeMirror measures text after a key; jsdom has no layout.
Range.prototype.getClientRects ??= (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as unknown as Range["getClientRects"];
Range.prototype.getBoundingClientRect ??= (() => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 })) as unknown as Range["getBoundingClientRect"];
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

// The chat page installs it on load (main.ts); here the test page does.
installImeGuard(window);

const key = (target: EventTarget, init: KeyboardEventInit & { keyCode?: number }, type = "keydown") => {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
  target.dispatchEvent(event);
  return event;
};
const compose = (target: EventTarget, type: "compositionstart" | "compositionend") =>
  target.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "你" }));

/** The Return of each way an input method commits a candidate. */
function commitWithReturn(target: EventTarget, kind: "chrome" | "webkit" | "webkit13"): void {
  if (kind === "chrome") {
    // Chrome: keydown first, still composing.
    compose(target, "compositionstart");
    key(target, { key: "Enter", isComposing: true, keyCode: 229 });
    compose(target, "compositionend");
  } else {
    // WebKit on macOS (WKWebView): compositionend first, then Return with isComposing false.
    compose(target, "compositionstart");
    compose(target, "compositionend");
    key(target, { key: "Enter", isComposing: false, keyCode: kind === "webkit" ? 229 : 13 });
    key(target, { key: "Enter", keyCode: 13 }, "keypress");
  }
}

let now = 1_000_000;
beforeEach(() => {
  sent.length = 0;
  document.body.innerHTML = "";
  now += 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

/** A while later: the next Return is the user's own. */
const later = () => { now += compositionGrace + 50; };

describe("the input-method guard", () => {
  it("stops Return that commits a candidate before any page handler, in every order WebKit and Chrome send it", () => {
    const input = document.body.appendChild(document.createElement("input"));
    const heard: string[] = [];
    input.addEventListener("keydown", (event) => heard.push(`keydown ${event.key}`));
    input.addEventListener("keypress", (event) => heard.push(`keypress ${event.key}`));
    window.addEventListener("keydown", (event) => heard.push(`window ${event.key}`));
    for (const kind of ["chrome", "webkit", "webkit13"] as const) {
      later();
      commitWithReturn(input, kind);
    }
    expect(heard).toEqual([]);
    later();
    const own = key(input, { key: "Enter", keyCode: 13 });
    expect(heard).toEqual(["keydown Enter", "window Enter"]);
    expect(own.defaultPrevented).toBe(false);
  });

  it("leaves other keys alone while composing, and cancels the default of a late Return only", () => {
    const input = document.body.appendChild(document.createElement("input"));
    const heard: string[] = [];
    input.addEventListener("keydown", (event) => heard.push(event.key));
    compose(input, "compositionstart");
    key(input, { key: "a", isComposing: true, keyCode: 229 });
    const during = key(input, { key: "Enter", isComposing: true, keyCode: 229 });
    compose(input, "compositionend");
    const after = key(input, { key: "Enter", keyCode: 13 });
    expect(heard).toEqual(["a"]);
    // During composition its default is the commit itself: leave it.
    expect(during.defaultPrevented).toBe(false);
    expect(after.defaultPrevented).toBe(true);
  });

  it("does not submit a form on an input method's Return", () => {
    const form = document.body.appendChild(document.createElement("form"));
    const input = form.appendChild(document.createElement("input"));
    const submitted = vi.fn();
    form.addEventListener("submit", (event) => { event.preventDefault(); submitted(); });
    commitWithReturn(input, "webkit13");
    expect(submitted).not.toHaveBeenCalled();
  });

  it("isComposingEnter knows the WebKit Return that comes after compositionend", () => {
    const input = document.body.appendChild(document.createElement("textarea"));
    compose(input, "compositionstart");
    compose(input, "compositionend");
    const late = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(late, "target", { value: input });
    expect(isComposingEnter(late)).toBe(true);
    expect(isComposingEnter(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(true);
    later();
    expect(isComposingEnter(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
    expect(isComposingEnter(new KeyboardEvent("keydown", { key: "a", isComposing: true }))).toBe(false);
  });
});

function chatState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    botID: "b1", botName: "Main bot", messages: [], working: false, avatar: "", placeholder: "Make a wish…",
    replyingTo: null, pendingFiles: [], components: {}, ...overrides,
  } as ChatState;
}

describe("the chat composer", () => {
  it("does not send on the Return that commits a candidate; plain Return sends; Shift-Return is a new line", () => {
    const composer = new Composer(document.body);
    composer.update(chatState());
    const content = composer.view.contentDOM;
    composer.setText("你好");
    composer.view.dispatch({ selection: { anchor: composer.view.state.doc.length } });
    for (const kind of ["chrome", "webkit", "webkit13"] as const) {
      later();
      commitWithReturn(content, kind);
    }
    expect(sent).toEqual([]);
    expect(composer.text).toBe("你好");

    later();
    key(content, { key: "Enter", shiftKey: true, keyCode: 13 });
    expect(sent).toEqual([]);
    expect(composer.text).toBe("你好\n");

    composer.setText("你好");
    key(content, { key: "Enter", keyCode: 13 });
    expect(sent).toEqual([{ type: "send", text: "你好" }]);
    expect(composer.text).toBe("");
  });
});

function specState(overrides: Partial<SpecState> = {}): SpecState {
  return {
    id: "S1", name: "test-summary", about: "Test results", status: "done", draft: 2,
    chat: "ClaudeCodeBot", from: "", suggestedBy: null, existing: null,
    fields: [{ name: "total", type: "int", by: "app" }],
    command: "swift test", folder: "/Users/me/ClaudeCodeBot", refresh: "manual", minutes: 15,
    bots: [{ name: "ClaudeCodeBot", on: true }], similar: null, similarAbout: null, reuse: false,
    samples: [], questions: [], conversation: [], origins: {},
    preview: null, components: {}, testRun: null, steps: null, wide: false,
    ...overrides,
  } as SpecState;
}

describe("the spec panel", () => {
  it("Ask for changes… does not send on the Return that commits a candidate; plain Return sends; Shift-Return does not", () => {
    const root = document.body.appendChild(document.createElement("div"));
    new SpecPanel(root).update(specState());
    const box = root.querySelector<HTMLTextAreaElement>(".spec-say textarea")!;
    expect(box.placeholder).toBe("Ask for changes…");
    box.value = "失敗的要列名字";
    for (const kind of ["chrome", "webkit", "webkit13"] as const) {
      later();
      commitWithReturn(box, kind);
    }
    expect(sent).toEqual([]);
    later();
    const shift = key(box, { key: "Enter", shiftKey: true, keyCode: 13 });
    expect(shift.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    key(box, { key: "Enter", keyCode: 13 });
    expect(sent).toEqual([{ type: "specSay", id: "S1", text: "失敗的要列名字" }]);
  });

  it("a field keeps focus on the Return that commits a candidate, and is done on plain Return", () => {
    const root = document.body.appendChild(document.createElement("div"));
    new SpecPanel(root).update(specState());
    const input = root.querySelector<HTMLInputElement>("input.spec-input")!;
    input.focus();
    commitWithReturn(input, "webkit");
    expect(document.activeElement).toBe(input);
    later();
    key(input, { key: "Enter", keyCode: 13 });
    expect(document.activeElement).not.toBe(input);
  });
});

describe("a component frame", () => {
  it("runs the guard before the template, so a template's own send-on-Enter never fires on a candidate", async () => {
    const template = `<input id="t"><script>
      document.getElementById('t').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') ccb.answer(event.target.value);
      });
    </script>`;
    const page = componentPage(template, "{}");
    expect(page.indexOf(imeGuardScript)).toBeGreaterThan(-1);
    expect(page.indexOf(imeGuardScript)).toBeLessThan(page.indexOf("window.ccb = {"));
    expect(page.indexOf(imeGuardScript)).toBeLessThan(page.indexOf(template));

    // The whole frame page, scripts and all, in a window of its own (what the iframe gets).
    type FrameWindow = Window & typeof globalThis;
    const { JSDOM } = (await import("jsdom" as string)) as { JSDOM: new (html: string, options: object) => { window: FrameWindow } };
    const dom = new JSDOM(page, {
      runScripts: "dangerously",
      beforeParse(win: FrameWindow) {
        (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
      },
    });
    const inner = dom.window;
    const answers: unknown[] = [];
    // A frame's parent is itself here: ccb.answer posts to this window.
    inner.addEventListener("message", (event: MessageEvent) => { if ((event.data as { ccb?: string })?.ccb === "answer") answers.push(event.data); });
    let frameNow = 5_000_000;
    vi.spyOn(inner.Date, "now").mockImplementation(() => frameNow);
    const input = inner.document.getElementById("t") as HTMLInputElement;
    input.value = "你";
    const fire = (type: string, init: Record<string, unknown> & { keyCode?: number }) => {
      const event = type.startsWith("composition")
        ? new inner.CompositionEvent(type, { bubbles: true })
        : new inner.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
      input.dispatchEvent(event);
    };
    fire("compositionstart", {});
    fire("compositionend", {});
    fire("keydown", { key: "Enter", keyCode: 229 });
    fire("keydown", { key: "Enter", keyCode: 13 });
    fire("compositionstart", {});
    fire("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
    fire("compositionend", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answers).toEqual([]);
    frameNow += compositionGrace + 50;
    fire("keydown", { key: "Enter", keyCode: 13 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answers).toEqual([{ ccb: "answer", text: "你" }]);
    dom.window.close();
  });
});

/** Every .ts file under `dir`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "test" || name === "dist" ? [] : sources(path);
    return path.endsWith(".ts") && !path.endsWith(".d.ts") ? [path] : [];
  });
}

describe("every Enter handler in Web/src", () => {
  it("goes through ime.ts (isComposingEnter / isComposingKey / isSendEnter), so no input box sends on a candidate pick", () => {
    const web = join(__dirname, "..");
    const files = [...sources(join(web, "src")), ...sources(join(web, "plugins"))].filter((file) => !file.endsWith("/src/ime.ts"));
    // A check for Return: key === "Enter", key !== 'Enter', a keymap's key: "Enter", keyCode 13, ["Enter", …].includes(…).
    const enterCheck = /key\s*[!=]==?\s*["']Enter["']|\bkey:\s*["']Enter["']|keyCode\s*[!=]==?\s*13\b|\[[^\]]*["']Enter["'][^\]]*\]\.includes/;
    const helper = /\bis(ComposingEnter|ComposingKey|SendEnter)\(/;
    const unguarded: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!enterCheck.test(line) || line.trim().startsWith("//") || line.trim().startsWith("*")) return;
        // The helper on the same line, or earlier in the same handler (up to 12 lines up).
        if (lines.slice(Math.max(0, index - 12), index + 1).some((l) => helper.test(l))) return;
        unguarded.push(`${relative(web, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(unguarded, "An Enter handler that does not check ime.ts's isComposingEnter: it would send on a Zhuyin/Pinyin candidate pick").toEqual([]);
  });

  it("the scan itself catches a handler that only checks event.isComposing", () => {
    const enterCheck = /key\s*[!=]==?\s*["']Enter["']/;
    const helper = /\bis(ComposingEnter|ComposingKey|SendEnter)\(/;
    const bad = `box.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) send(); });`;
    expect(enterCheck.test(bad) && !helper.test(bad)).toBe(true);
  });
});
