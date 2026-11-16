// @vitest-environment jsdom
// The Note tab's frame: the shipped dist/web.js (built from src/web.ts, out/ is built before the unit tests run) registers
// the tab's view and draws the bot's note from what the program part answers, formulas with KaTeX whose fonts travel inside
// the bundle (the sandboxed frame loads no stylesheet or font file).
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";

const source = () => readFileSync(join(desktop, "out/builtin-plugins/botling.note/dist/web.js"), "utf8");
beforeEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });
// jsdom has no layout: what the editor measures with is there and quiet.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

it("registers the Note tab and draws the note: headings, a formula with inlined KaTeX fonts, the cells, and 問 opens the margin ask box and can quote a cell by its id", async () => {
  const text = "# Plan\n\nEnergy is $E = mc^2$.\n<!-- cell -->\nSecond cell\n";
  const calls: [string, unknown][] = [];
  const views = new Map<string, (root: HTMLElement) => (() => void) | void>();
  const ccb = {
    context: { botId: "B1" },
    panels: { register: (id: string, fn: (root: HTMLElement) => (() => void) | void) => { views.set(id, fn); return () => {}; } },
    host: {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push([method, params]);
        if (method === "read") return { text, mtime: 1 };
        if (method === "write") return { saved: true, mtime: 2 };
        // note.db's ids for the cells as the editor cut them (notes.outline), for the 問 quote's first line.
        if (method === "outline") return { mode: "db", cells: [...document.querySelectorAll<HTMLElement>(".cell")].map((cell, i) => ({ id: `c${i}`, start: Number(cell.dataset.start), end: Number(cell.dataset.end), label: `Note #c${i}` })), forks: [] };
        return null;
      }),
    },
    on: () => () => {},
    notify: vi.fn(),
    composer: { insertQuote: vi.fn(async () => ({ inserted: true })) },
  };
  const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source()).toString("base64")}`);
  module.activate(ccb);
  expect([...views.keys()]).toEqual(["botling.note.tab"]);
  const root = document.createElement("div");
  document.body.append(root);
  const stop = views.get("botling.note.tab")!(root);
  await vi.waitFor(() => expect(root.textContent).toContain("Second cell"));
  expect(calls.some(([method, params]) => method === "read" && (params as { botId: string }).botId === "B1")).toBe(true);
  expect(root.querySelector(".nl-h1")?.textContent).toContain("Plan");
  expect(root.querySelector(".katex")).not.toBeNull();
  const katex = document.getElementById("botling-note-katex")?.textContent ?? "";
  expect(katex.match(/data:font\/woff2;base64,/g)?.length).toBe(20);
  expect(katex).not.toMatch(/url\(fonts\//);
  // The cell line is the app's, never shown as text: two cells.
  expect(root.textContent).not.toContain("<!-- cell");
  const cells = root.querySelectorAll<HTMLElement>(".cell");
  expect(cells).toHaveLength(2);
  // 問 on the second cell opens the margin ask box (nothing is sent yet); its "改為引用到對話" puts the cell's Markdown as a
  // quote into the bot's composer, named by its id in note.db.
  cells[1]!.querySelector<HTMLButtonElement>(".cell-ask")!.click();
  await vi.waitFor(() => expect(root.querySelector(".nm-draft")).not.toBeNull());
  expect(ccb.composer.insertQuote).not.toHaveBeenCalled();
  [...root.querySelectorAll<HTMLButtonElement>(".nm-draft button")].find((b) => b.textContent === "改為引用到對話")!.click();
  await vi.waitFor(() => expect(ccb.composer.insertQuote).toHaveBeenCalled());
  expect(ccb.composer.insertQuote.mock.calls[0]).toEqual(["> 〔Note #c1〕\n> Second cell", { focus: true }]);
  if (typeof stop === "function") stop();
  expect(document.getElementById("botling-note-katex")).toBeNull();
});
