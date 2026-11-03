// The status strip above the input box follows the user's message column width (frame.css --message-column-width);
// a fixed width in the board plugin's stylesheet (loaded after frame.css) would pin it at 640px, off-centre in a wide column.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
it("the pin strip takes the message column width, not a fixed one", () => {
  const css = readFileSync("builtin-plugins/botling.board/src/board.css", "utf8");
  const rule = css.split("\n").find((line) => line.startsWith("#pin-area {")) ?? "";
  expect(rule).toContain("max-width: var(--message-column-width");
  expect(rule).not.toMatch(/max-width:\s*\d+px/);
});
