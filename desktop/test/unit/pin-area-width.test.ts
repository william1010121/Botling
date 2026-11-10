// The status strip above the input box fills the chat like the transcript does (frame.css); a fixed width in the
// board plugin's stylesheet (loaded after frame.css) would pin it narrow and off-centre in a wide chat.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
it("the pin strip takes the chat's full width, not a fixed one", () => {
  const css = readFileSync("builtin-plugins/botling.board/src/board.css", "utf8");
  const rule = css.split("\n").find((line) => line.startsWith("#pin-area {")) ?? "";
  expect(rule).toContain("max-width: none");
  expect(rule).not.toMatch(/max-width:\s*(\d+px|var\()/);
});
