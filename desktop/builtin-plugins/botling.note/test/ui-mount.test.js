// @vitest-environment jsdom
// The Note page, mounted from source (src/ui.js, not the built dist/web.js) in a headless DOM (jsdom, no window), with a
// fixture note and a fake `ccb` (the host the frame gets). Each scenario pins what the user sees as a DOM golden
// (test/ui-mount.golden/<name>.html: the markup of the page root, one element per line, plus the calls the page made
// to the host and the text it saved), so the cards that cut ui.js into parts can prove the page still draws the same.
//
// vitest.config.mts only collects `*.test.ts` here, so this file is run through ui-mount-run.test.ts (it only imports this).
// Goldens are recorded on the base commit; a changed golden is a changed page: look at the diff, never just re-record.
// jsdom has no layout: getBoundingClientRect is faked below (a cell is 80 px tall every 100 px) so a drag has somewhere to go.
// Time is faked (vi.useFakeTimers): saving waits 700 ms, cards sync after 350 ms, polling every 3 s; no real waiting.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activate } from "../src/ui.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const GOLD = (name) => `./ui-mount.golden/${name}.html`;

// ---- the fake layout and the missing browser calls ----
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() {} });
const realRect = Element.prototype.getBoundingClientRect;
const realFromPoint = document.elementFromPoint;
beforeEach(() => {
  Element.prototype.getBoundingClientRect = function () {
    const p = this.parentElement;
    if (p && p.classList.contains("note-doc")) return rect(0, [...p.children].indexOf(this) * 100, 600, 80);
    return rect(0, 0, 0, 0);
  };
  document.elementFromPoint = () => null;
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  try { localStorage.clear(); } catch {} // the page keeps the line and routes there when the app has no plugin storage
  vi.useFakeTimers();
});

// ---- the fake host ----
// env.text / env.mtime are the note file as the app has it; calls is what the page asked, in order.
let current = null;
afterEach(() => {
  current?.stop?.();
  current = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  Element.prototype.getBoundingClientRect = realRect;
  document.elementFromPoint = realFromPoint;
});

const COMPONENTS = { components: [{ name: "weather", title: "天氣", command: null, offered: true }, { name: "clock", title: "時鐘", command: "date", every: 60, offered: false }] };
const SHOW = /^<show name="([^"]+)">(.*)<\/show>$/;

function makeEnv(text) {
  const env = { text, mtime: 1, view: null, calls: [], handlers: {}, writeResult: null, stop: null };
  env.cardsOf = (t) => t.split("\n").flatMap((l, line) => {
    const m = SHOW.exec(l);
    return m ? [{ line, name: m[1], key: `k${line}`, exists: true, status: "static", data: m[2], command: null, every: null }] : [];
  });
  env.ccb = {
    context: { botId: "B1" },
    panels: { register: (id, fn) => { env.view_fn = fn; } },
    host: {
      call: async (method, params) => {
        // the margin comments (旁註) have their own tests (ui-margin.test.js); none here, and their calls stay out of the goldens
        if (method.startsWith("margin")) return method === "marginList" ? { threads: [] } : null;
        env.calls.push(method === "write" ? `write ${JSON.stringify(params.text)} base=${params.base}` : method === "viewSet" ? `viewSet ${JSON.stringify(params.view)}` : method);
        if (method === "read") return { text: env.text, mtime: env.mtime };
        if (method === "write") {
          if (env.writeResult) return env.writeResult;
          if (params.base !== env.mtime) return { saved: false, text: env.text, mtime: env.mtime };
          env.text = params.text;
          env.mtime += 1;
          return { saved: true, mtime: env.mtime };
        }
        if (method === "viewGet") return env.view;
        if (method === "viewSet") { env.view = params.view; return null; }
        if (method === "cards") return env.cardsOf(params.text);
        if (method === "components") return COMPONENTS;
        if (method === "assetUrls") return {};
        return null;
      },
    },
    on: (name, fn) => { env.handlers[name] = fn; return () => { delete env.handlers[name]; }; },
    notify() {},
    card: async ({ component }) => `https://card.invalid/${component}`,
    snapshot: async () => ({ ref: "note-assets/frozen1.png", url: "https://asset.invalid/frozen1.png" }),
  };
  return env;
}

// Mounts the page on `env` (made from `text` when not given) and lets the first read, render and syncs finish.
async function open(text, env = makeEnv(text)) {
  document.body.innerHTML = "";
  const root = document.createElement("div");
  document.body.append(root);
  activate(env.ccb);
  env.stop = env.view_fn(root);
  env.root = root;
  current = env;
  await settle(10);
  return env;
}
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

// ---- the DOM golden: the root's markup, one element per line, what jsdom keeps as properties written out ----
// The per-cell chrome (ask button, grip, toolbar) is the same in every cell: only the load golden spells it out (full).
const CHROME = new Set(["cell-ask", "cell-grip", "cell-bar"]);
function dump(node, depth, out, full) {
  const pad = "  ".repeat(depth);
  if (node.nodeType === 3) {
    if (node.textContent.trim()) out.push(`${pad}${JSON.stringify(node.textContent)}`);
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = node.localName;
  const attrs = [...node.attributes].map((a) => ` ${a.name}=${JSON.stringify(a.value)}`).join("");
  const extra = (tag === "textarea" || tag === "input" ? ` value=${JSON.stringify(node.value)}` : "") + (node === document.activeElement ? " [focus]" : "");
  if (tag === "svg") return void out.push(`${pad}<svg${attrs}/>`); // icons: their drawing is not what is pinned
  out.push(`${pad}<${tag}${attrs}${extra}>`);
  if (!full && [...node.classList].some((c) => CHROME.has(c))) return;
  for (const child of node.childNodes) dump(child, depth + 1, out, full);
}
const golden = (env, full) => {
  const out = [];
  for (const child of env.root.childNodes) dump(child, 0, out, full);
  return `${out.join("\n")}\n--- host calls\n${env.calls.join("\n")}\n--- saved note\n${JSON.stringify(env.text)}\n`;
};
const pin = (env, name) => expect(golden(env, name === "01-load")).toMatchFileSnapshot(GOLD(name));

// ---- what a user does ----
const q = (env, sel) => env.root.querySelector(sel);
const qa = (env, sel) => [...env.root.querySelectorAll(sel)];
const lineEl = (env, text) => qa(env, ".nl").find((el) => el.textContent.includes(text));
const mouse = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
const down = (env, el) => mouse(el, "mousedown");
const click = (el) => mouse(el, "click");
const key = (el, k, init = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const input = (el) => el.dispatchEvent(new InputEvent("input", { bubbles: true }));
const textarea = (env) => q(env, ".nl-active textarea");
const typeIn = async (ta, value) => { ta.value = value; ta.setSelectionRange(value.length, value.length); input(ta); await settle(); };
const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
const button = (env, label) => qa(env, "button").find((b) => b.textContent.includes(label) || b.title === label);
const menuItem = (env, label) => qa(env, ".nb-menu .nb-mi").find((b) => b.textContent.includes(label));

const FIXTURE = [
  "# Plan", "", "Energy is $E = mc^2$ and **bold** with `code`.", "- [ ] first todo", "<!-- cell -->",
  "| a | b |", "| - | - |", "| 1 | 2 |", "<!-- cell -->", '<show name="weather">{"city":"Taipei"}</show>',
  "<!-- cell -->", "```js", "const x = 1;", "```", "<!-- cell -->", "<!-- branch: 學習率 -->", "<!-- route: lr=3e-4 -->", "slow route",
  "<!-- route: lr=1e-3 -->", "fast route", "<!-- end branch -->", "tail cell", "",
].join("\n");
const FORK = "intro\n<!-- cell -->\n<!-- branch: 學習率 -->\n<!-- route: slow -->\nslow text\n<!-- route: fast -->\nfast text\n<!-- end branch -->\nafter\n";
const EMPTY_FORKS = "intro\n<!-- cell -->\n<!-- branch: A -->\n<!-- route: a1 -->\n<!-- route: a2 -->\n<!-- end branch -->\n<!-- branch: B -->\n<!-- route: b1 -->\n<!-- route: b2 -->\n<!-- end branch -->\nend\n";
const NESTED = [
  "intro", "<!-- cell -->", "<!-- branch: A -->", "<!-- route: a1 -->", "x", "<!-- branch: B -->", "<!-- route: b1 -->", "y",
  "<!-- route: b2 -->", "z", "<!-- end branch -->", "<!-- route: a2 -->", "w", "<!-- end branch -->", "end", "",
].join("\n");

describe("the Note page, mounted from source", () => {
  it("load: a fixture note with a heading, a formula, a todo, a table, a card, code and a fork is drawn, the app is asked what it needs", async () => {
    const env = await open(FIXTURE);
    expect(q(env, ".nl-h1")?.textContent).toContain("Plan");
    expect(q(env, ".katex")).not.toBeNull();
    expect(q(env, ".nb-st").textContent).toBe("Saved");
    expect(qa(env, ".cell").map((c) => c.dataset.type)).toEqual(["markdown", "table", "card", "code", "branch", "markdown", "markdown"]);
    expect(q(env, ".nb-crumb").hidden).toBe(false);
    expect(env.calls.slice(0, 3)).toEqual(["viewGet", "read", "parse"]);
    await pin(env, "01-load");
  });

  it("type in a cell: a click opens the line as a text box, typing shows Editing…, 700 ms later the note is saved", async () => {
    const env = await open("# Title\n\nHello world\n");
    down(env, lineEl(env, "Hello world"));
    await settle();
    const ta = textarea(env);
    expect(ta.value).toBe("Hello world");
    expect(document.activeElement).toBe(ta);
    await pin(env, "02a-type-open");
    await typeIn(ta, "Hello brave world");
    expect(q(env, ".nb-st").textContent).toBe("Editing…");
    expect(env.text).toBe("# Title\n\nHello world\n");
    await settle(699);
    expect(env.text).toBe("# Title\n\nHello world\n");
    await pin(env, "02b-type-dirty");
    await settle(1);
    expect(env.text).toBe("# Title\n\nHello brave world\n");
    expect(q(env, ".nb-st").textContent).toBe("Saved");
    await pin(env, "02c-type-saved");
  });

  it("insert menu: '/' opens it, typing filters it, ArrowDown moves, Enter inserts; Escape closes it", async () => {
    const env = await open("first line\n\nlast line");
    down(env, lineEl(env, "last line"));
    await settle();
    await typeIn(textarea(env), "/");
    expect(q(env, ".nb-menu")).not.toBeNull();
    expect(qa(env, ".nb-menu .nb-mi")).toHaveLength(10);
    await pin(env, "03a-insert-menu");
    key(textarea(env), "ArrowDown");
    expect(qa(env, ".nb-menu .nb-mi").findIndex((b) => b.getAttribute("aria-selected") === "true")).toBe(1);
    await typeIn(textarea(env), "/表");
    expect(qa(env, ".nb-menu .nb-mi").map((b) => b.querySelector(".lb").textContent)).toEqual(["表格"]);
    await pin(env, "03b-insert-menu-filtered");
    key(textarea(env), "Enter");
    await settle(800);
    expect(q(env, ".nb-menu")).toBeNull();
    expect(env.text).toMatch(/\| .* \|/);
    expect(q(env, "table.nt")).not.toBeNull();
    await pin(env, "03c-insert-table");
    // Escape: the menu stays closed until the text stops being a slash command
    down(env, lineEl(env, "first line"));
    await settle();
    await typeIn(textarea(env), "/h");
    expect(q(env, ".nb-menu")).not.toBeNull();
    key(textarea(env), "Escape");
    expect(q(env, ".nb-menu")).toBeNull();
    expect(q(env, ".nl-active")).not.toBeNull();
    await pin(env, "03d-insert-menu-escaped");
  });

  it("table edit: a click edits a table cell in place, Tab at the last cell adds a row, the menu inserts a column, the file keeps tidy pipes", async () => {
    const env = await open("| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n");
    down(env, q(env, 'td[data-r="0"][data-c="1"]'));
    await settle();
    const ed = q(env, ".nt-ed");
    expect(ed.textContent).toBe("2");
    expect(q(env, ".nt-box").classList.contains("nt-editing")).toBe(true);
    await pin(env, "04a-table-cell-open");
    ed.textContent = "22";
    input(ed);
    expect(env.text).toBe("| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n"); // not saved yet
    key(ed, "Tab");
    await settle(800);
    expect(env.text).toBe("| a   | b   |\n| --- | --- |\n| 1   | 22  |\n|     |     |\n\nafter\n");
    expect(qa(env, "tbody tr")).toHaveLength(2);
    await pin(env, "04b-table-typed-and-row-added");
    mouse(q(env, 'th[data-c="0"]'), "contextmenu", { clientX: 10, clientY: 10 });
    expect(q(env, ".nb-menu .nb-mh").textContent).toBe("表頭 · 第 1 欄");
    await pin(env, "04c-table-menu");
    click(menuItem(env, "在右邊插入一欄"));
    await settle(800);
    expect(qa(env, "thead th")).toHaveLength(3);
    expect(env.text.split("\n")[0].split("|")).toHaveLength(5);
    await pin(env, "04d-table-column-added");
    key(q(env, ".nt-ed"), "Escape");
    await settle();
    expect(q(env, ".nt-ed")).toBeNull();
    await pin(env, "04e-table-left");
  });

  it("card draw and freeze: the card's frame is drawn once the app answers, 凍結成圖片 turns the <show> line into a picture, ⌘Z brings the card back", async () => {
    const env = await open('intro\n<!-- cell -->\n<show name="weather">{"city":"Taipei"}</show>\n');
    expect(q(env, ".nc-title").textContent).toBe("weather");
    expect(q(env, ".nc-frame")).toBeNull();
    expect(q(env, ".nc-status").textContent).toBe("載入中…");
    await settle(400);
    const frame = q(env, ".nc-layer .nc-frame");
    expect(frame.getAttribute("src")).toBe("https://card.invalid/weather");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(env.calls).toContain("cards");
    await pin(env, "05a-card-drawn");
    click(q(env, ".nc-btn[title^='把卡片現在的樣子存成圖片']"));
    await settle(100);
    expect(env.text).toBe("intro\n<!-- cell -->\n![weather](note-assets/frozen1.png)\n");
    expect(q(env, ".nc-box")).toBeNull();
    expect(q(env, ".nc-frame")).toBeNull();
    await pin(env, "05b-card-frozen");
    key(document, "z", { metaKey: true });
    await settle(450);
    expect(q(env, ".nc-title").textContent).toBe("weather");
    expect(q(env, ".nc-layer .nc-frame")).not.toBeNull();
    await settle(800);
    expect(env.text).toBe('intro\n<!-- cell -->\n<show name="weather">{"city":"Taipei"}</show>\n');
    await pin(env, "05c-card-restored");
  });

  it("drag a cell: the grip lifts a ghost, a drop line shows the gap, dropping moves the cell, ⌘Z takes it back", async () => {
    const env = await open("one\n<!-- cell -->\ntwo\n<!-- cell -->\nthree\n");
    expect(qa(env, ".cell").map((c) => c.dataset.start)).toEqual(["0", "2", "4"]);
    const grip = q(env, '.cell[data-start="0"] .cell-grip');
    pointer(grip, "pointerdown", 5, 10);
    pointer(document, "pointermove", 5, 12);
    expect(q(env, ".nd-ghost")).toBeNull(); // under 4 px of travel is not a drag yet
    pointer(document, "pointermove", 20, 150);
    await settle(20);
    expect(q(env, ".note").classList.contains("nd-on")).toBe(true);
    expect(q(env, ".nd-ghost")).not.toBeNull();
    expect(q(env, '.cell[data-start="0"]').classList.contains("cell-dragging")).toBe(true);
    pointer(document, "pointermove", 20, 290); // nearest gap: after the last cell
    await settle(20);
    expect(q(env, ".nd-line").hidden).toBe(false);
    expect(q(env, ".nd-tag").textContent).toBe("放進：共用內容");
    await pin(env, "06a-drag-over-last-gap");
    pointer(document, "pointerup", 20, 290);
    await settle(800);
    expect(env.text).toBe("two\n<!-- cell -->\nthree\n<!-- cell -->\none\n");
    expect(q(env, ".nd-ghost")).toBeNull();
    expect(q(env, ".cell-dropped")).not.toBeNull();
    expect(q(env, ".nb-st").textContent).toBe("Saved");
    await pin(env, "06b-drag-dropped");
    key(document, "z", { metaKey: true });
    await settle(800);
    expect(env.text).toBe("one\n<!-- cell -->\ntwo\n<!-- cell -->\nthree\n");
    await pin(env, "06c-drag-undone");
    // a drag the user abandons (Escape) leaves the note as it was
    pointer(q(env, '.cell[data-start="0"] .cell-grip'), "pointerdown", 5, 10);
    pointer(document, "pointermove", 5, 150);
    await settle(20);
    expect(q(env, ".nd-ghost")).not.toBeNull();
    key(document, "Escape");
    await settle(20);
    expect(q(env, ".nd-ghost")).toBeNull();
    expect(env.text).toBe("one\n<!-- cell -->\ntwo\n<!-- cell -->\nthree\n");
  });

  it("fork bar: the route tabs switch what is shown, + adds a route that is named in place, the tab menu deletes one", async () => {
    const env = await open(FORK);
    expect(qa(env, ".nb-tab[data-route]").map((t) => [t.dataset.route, t.getAttribute("aria-selected")])).toEqual([["slow", "true"], ["fast", "false"]]);
    expect(lineEl(env, "slow text")).toBeTruthy();
    expect(lineEl(env, "fast text")).toBeFalsy();
    await pin(env, "07a-fork-bar");
    click(q(env, '.nb-tab[data-route="fast"]'));
    await settle(600);
    expect(lineEl(env, "fast text")).toBeTruthy();
    expect(lineEl(env, "slow text")).toBeFalsy();
    expect(env.view.routes).toEqual({ "學習率#1": "fast" });
    expect(q(env, ".nb-crumb").title).toBe("學習率 › fast");
    await pin(env, "07b-fork-route-picked");
    click(q(env, ".nb-add"));
    await settle();
    const name = q(env, ".nb-tab input.nb-input");
    expect(name.value).toBe("路線 3");
    await pin(env, "07c-fork-route-added");
    name.value = "mid";
    key(name, "Enter");
    await settle(800);
    expect(env.text).toContain("<!-- route: mid -->");
    expect(qa(env, ".nb-tab[data-route]").map((t) => t.dataset.route)).toEqual(["slow", "fast", "mid"]);
    await pin(env, "07d-fork-route-named");
    mouse(q(env, '.nb-tab[data-route="mid"]'), "contextmenu");
    expect(qa(env, ".nb-menu .nb-mi").map((b) => b.querySelector(".lb").textContent)).toEqual(["改名", "刪除這條路線…"]);
    click(menuItem(env, "刪除這條路線"));
    expect(menuItem(env, "確定刪除")).toBeTruthy();
    await pin(env, "07e-fork-delete-confirm");
    click(menuItem(env, "確定刪除"));
    await settle(800);
    expect(env.text).not.toContain("mid");
    expect(qa(env, ".nb-tab[data-route]").map((t) => t.dataset.route)).toEqual(["slow", "fast"]);
    await pin(env, "07f-fork-route-deleted");
  });

  it("map: the route button opens the overview of every fork and route, a node switches to that route and closes it", async () => {
    const env = await open(EMPTY_FORKS);
    expect(q(env, ".nb-crumb").title).toBe("A › a1 · B › b1");
    expect(q(env, ".nb-map")).toBeNull();
    click(q(env, ".nb-crumb"));
    expect(q(env, ".nb-map")).not.toBeNull();
    expect(q(env, ".nb-crumb").getAttribute("aria-expanded")).toBe("true");
    expect(qa(env, ".nb-map .nb-node .nm").map((n) => n.textContent)).toEqual(["共用開頭", "a1", "a2", "b1", "b2"]);
    await pin(env, "08a-map-open");
    click(qa(env, ".nb-map .nb-node").find((n) => n.querySelector(".nm").textContent === "b2"));
    await settle(600);
    expect(q(env, ".nb-map")).toBeNull();
    expect(q(env, ".nb-crumb").title).toBe("A › a1 · B › b2");
    expect(env.view.routes).toEqual({ "B#1": "b2" });
    await pin(env, "08b-map-route-b2");
    click(q(env, ".nb-crumb"));
    expect(q(env, ".nb-map")).not.toBeNull();
    key(document, "Escape");
    expect(q(env, ".nb-map")).toBeNull();
    click(q(env, ".nb-crumb"));
    mouse(env.root.querySelector(".nb-body, .note-body"), "mousedown"); // a click elsewhere closes it too
    await settle();
    expect(q(env, ".nb-map")).toBeNull();
    await pin(env, "08c-map-closed");
  });

  // This was a pinned bug (branch.js routeFacts used an undefined MARKER, so drawMap threw for any note with text in a route);
  // fixed on main by bot/fix-note-routefacts, so the test now pins the overview that opens for such a note.
  it("map: with a route that has text in it the overview opens and lists every fork and route", async () => {
    const errors = [];
    const onError = (e) => { e.preventDefault(); errors.push(e.error); };
    window.addEventListener("error", onError);
    try {
      const env = await open(NESTED);
      click(q(env, ".nb-crumb"));
      expect(errors).toEqual([]);
      expect(q(env, ".nb-map")).not.toBeNull();
      expect(q(env, ".nb-crumb").getAttribute("aria-expanded")).toBe("true");
      expect(qa(env, ".nb-map .nb-node .nm").map((n) => n.textContent)).toEqual(["共用開頭", "a1", "b1", "b2", "a2"]);
      await pin(env, "08d-map-routes-with-text");
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("keyboard moves: arrows walk the lines, Enter splits and keeps a list going, Backspace joins, ⌥↓ moves the cell, ⌘Z undoes it", async () => {
    const env = await open("alpha\nbeta\n<!-- cell -->\n- gamma\n<!-- cell -->\ndelta\n");
    down(env, lineEl(env, "alpha"));
    await settle();
    key(textarea(env), "ArrowDown");
    await settle();
    expect(textarea(env).value).toBe("beta");
    key(textarea(env), "ArrowDown"); // the next line is a cell line: skipped
    await settle();
    expect(textarea(env).value).toBe("- gamma");
    await pin(env, "09a-keys-arrow-down-to-gamma");
    textarea(env).setSelectionRange(7, 7);
    key(textarea(env), "Enter"); // the caret is at the end: a new list item
    await settle();
    expect(textarea(env).value).toBe("- ");
    await typeIn(textarea(env), "- more");
    await pin(env, "09b-keys-enter-keeps-list");
    key(textarea(env), "ArrowUp");
    await settle();
    expect(textarea(env).value).toBe("- gamma");
    textarea(env).setSelectionRange(0, 0);
    key(textarea(env), "ArrowLeft"); // at the start of the line: the end of the line before (a cell line is skipped)
    await settle();
    expect(textarea(env).value).toBe("beta");
    key(textarea(env), "ArrowRight"); // at the end: the start of the next editable line
    await settle();
    expect(textarea(env).value).toBe("- gamma");
    key(textarea(env), "ArrowDown");
    await settle();
    key(textarea(env), "ArrowDown");
    await settle();
    expect(textarea(env).value).toBe("delta");
    textarea(env).setSelectionRange(0, 0);
    key(textarea(env), "Backspace"); // delta is a cell of its own: the cell's first line does not join the cell above
    await settle();
    await pin(env, "09c-keys-backspace-at-cell-start");
    key(textarea(env), "ArrowUp", { altKey: true });
    await settle(800);
    // the cell moves up with the file's last (blank) line, which was part of it
    expect(env.text).toBe("alpha\nbeta\n<!-- cell -->\ndelta\n\n<!-- cell -->\n- gamma\n- more");
    await pin(env, "09d-keys-alt-up-moves-cell");
    key(textarea(env), "Escape");
    expect(q(env, ".nl-active")).toBeNull();
    key(document, "z", { metaKey: true });
    await settle(800);
    expect(env.text).toBe("alpha\nbeta\n<!-- cell -->\n- gamma\n- more\n<!-- cell -->\ndelta\n");
    await pin(env, "09e-keys-undo");
    // ⌃⇧- cuts the cell at the cursor, Tab indents
    down(env, lineEl(env, "alpha"));
    await settle();
    textarea(env).setSelectionRange(5, 5);
    key(textarea(env), "-", { ctrlKey: true, shiftKey: true, code: "Minus" });
    await settle();
    key(textarea(env), "Tab");
    await settle(800);
    expect(env.text).toBe("alpha\n<!-- cell -->\n  beta\n<!-- cell -->\n- gamma\n- more\n<!-- cell -->\ndelta\n");
    await pin(env, "09f-keys-split-and-tab");
  });

  it("save and reload: an edit is saved with the file's mtime, the view goes with it; a new mount reads the saved note and goes back to the line and the route", async () => {
    const env = await open(FORK);
    click(q(env, '.nb-tab[data-route="fast"]'));
    await settle();
    down(env, lineEl(env, "after"));
    await settle();
    await typeIn(textarea(env), "after, edited");
    await settle(800);
    expect(env.calls.filter((c) => c.startsWith("write "))).toEqual([`write ${JSON.stringify(FORK.replace("after", "after, edited"))} base=1`]);
    expect(env.mtime).toBe(2);
    await pin(env, "10a-saved");
    env.stop();
    expect(env.root.querySelector(".note")).toBeNull();
    expect(document.getElementById("botling-note-css")).toBeNull();
    expect(env.view.pos).toMatchObject({ line: 8, editing: true, text: "after, edited" });
    expect(env.view.routes).toEqual({ "學習率#1": "fast" });
    env.calls.length = 0;
    await open(null, env);
    expect(textarea(env).value).toBe("after, edited");
    expect(q(env, ".nb-crumb").title).toBe("學習率 › fast");
    expect(lineEl(env, "fast text")).toBeTruthy();
    expect(env.calls.slice(0, 2)).toEqual(["viewGet", "read"]);
    await pin(env, "10b-reloaded");
    // the file changed somewhere else: the app says so, the page draws the new text (an edit of its own would be kept)
    Object.assign(env, { text: FORK.replace("fast text", "fast text from the bot"), mtime: 5 });
    env.handlers.noteChanged({ botId: "B1", mtime: 5 });
    await settle(10);
    expect(lineEl(env, "from the bot")).toBeTruthy();
    await pin(env, "10c-changed-elsewhere");
  });

  it("save conflict: a save the file refuses shows the warning with its two buttons; Load their version takes the file's text", async () => {
    const env = await open("mine\n");
    down(env, lineEl(env, "mine"));
    await settle();
    await typeIn(textarea(env), "mine, edited");
    Object.assign(env, { text: "theirs\n", mtime: 9 }); // another writer got there first (base 1 is stale)
    await settle(800);
    expect(q(env, ".note-warn").hidden).toBe(false);
    expect(qa(env, ".note-warn button").map((b) => b.textContent)).toEqual(["Load their version", "Keep mine"]);
    await pin(env, "11a-conflict");
    click(qa(env, ".note-warn button")[0]);
    await settle(10);
    expect(q(env, ".note-warn").hidden).toBe(true);
    expect(lineEl(env, "theirs")).toBeTruthy();
    expect(q(env, ".nb-st").textContent).toBe("Saved");
    await pin(env, "11b-conflict-took-theirs");
  });
});
