import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// The chat page as the Board's tests need it: the page's kit lent to the plugin (what `PluginHost` does when it loads it), and the bars
// the plugin puts on a card in a reply (`ccb.messages.cardBar`, `specButton`), registered the way `activate` registers them.
import { extensions } from "../../../../Web/src/messages";
import { pageKit } from "../../../../Web/src/plugins";
import { useKit } from "../src/kit";
import { pinBar, specPinButton } from "../src/pins";

let bar: (typeof extensions.cardBars)[number] | null = null;
let button: (typeof extensions.specButtons)[number] | null = null;

/** The kit set, and (unless `bars` is false) the plugin's bars on cards in replies. */
export function installBoard({ bars = true }: { bars?: boolean } = {}): void {
  removeBoard();
  useKit(pageKit({ pinArea: document.createElement("div"), board: document.createElement("div"), overlay: document.body }));
  if (!bars) return;
  bar = { plugin: "botling.board", make: (display, messageID, index) => (display.pinned === undefined || display.pinned === null ? null : pinBar(display, messageID, index)) };
  button = { plugin: "botling.board", make: (spec) => specPinButton(spec) };
  extensions.cardBars.push(bar);
  extensions.specButtons.push(button);
}

export function removeBoard(): void {
  if (bar) extensions.cardBars.splice(extensions.cardBars.indexOf(bar), 1);
  if (button) extensions.specButtons.splice(extensions.specButtons.indexOf(button), 1);
  bar = button = null;
}

/** The chat page's stylesheet and the Board's, in the order the page loads them (the Board's after). */
export function pageCss(): string {
  return readFileSync(resolve(__dirname, "../../../../Web/src/chat.css"), "utf8") + "\n" + readFileSync(resolve(__dirname, "../src/board.css"), "utf8");
}
