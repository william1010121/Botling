// @vitest-environment jsdom
// The shipped ui.js (the built bundle, on Preact) in a page: it registers its view, draws the board from what the program part
// answers, and the SVG, input and click handling work the same as on React (board.test.ts).
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktop } from "../../../test/helpers";
import { board, bots, entries, site, waiting } from "./fixtures";

// out/ is built before the unit tests run (npm run build); esbuild itself cannot run inside jsdom.
const source = readFileSync(join(desktop, "out/builtin-plugins/botling.whiteboard/ui.js"), "utf8");

it("draws the board with Preact: cards, donuts as SVG, a report on press, the input sends", async () => {
  const calls: unknown[][] = [];
  let render!: (root: HTMLElement) => (() => void) | void;
  const ccb = {
    panels: { register: (id: string, fn: typeof render) => { calls.push(["register", id]); render = fn; return () => {}; } },
    call: async (method: string, params: unknown) => { calls.push([method, params]); return method === "board" ? board(bots, entries, waiting) : null; },
    command: (...args: unknown[]) => { calls.push(["command", ...args]); },
    tile: async () => "botling-card://page/x", requestApproval: async () => ({ allowed: false }), notify: () => {},
  };
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const module = await import(/* @vite-ignore */ url);
  module.activate(ccb);
  expect(calls[0]).toEqual(["register", "botling.whiteboard"]);
  const root = document.createElement("div"); document.body.append(root);
  render(root);
  for (let i = 0; i < 20 && !root.querySelector(".wb-card"); i++) await new Promise((r) => setTimeout(r, 10));
  const card = root.querySelector(`.wb-card[data-bot="${site.id}"]`)!;
  expect(card.querySelector(".wb-pill")?.textContent).toBe("1 waiting");
  expect(document.head.querySelector("style")?.textContent).toContain(".wb-canvas");
  expect(document.head.querySelector("style")?.textContent).toContain("--ground");
  const arc = root.querySelector('[data-donut="bots"] circle.arc');
  expect(arc?.getAttribute("class")).toContain("arc");
  expect((arc as SVGElement).style.strokeDasharray).not.toBe("");
  card.querySelector<HTMLButtonElement>(".wb-card-open")!.click();
  await new Promise((r) => setTimeout(r, 20));
  expect(root.querySelector(".wb-report")).not.toBeNull();
  root.querySelector<HTMLButtonElement>(".wb-report-chat")!.click();
  expect(calls).toContainEqual(["command", "botling.openChat", site.id]);
  const input = root.querySelector<HTMLTextAreaElement>(".wb-composer-input")!;
  input.value = "hi"; input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toContainEqual(["send", { text: "hi" }]);
});
