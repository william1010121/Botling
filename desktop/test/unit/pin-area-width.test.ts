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

it("in a narrow chat a chip with a value drops its icon, keeps its dot; wide chats keep the icon", () => {
  const css = readFileSync("builtin-plugins/botling.board/src/board.css", "utf8");
  const block = css.match(/@container status-strip \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/);
  expect(block).not.toBeNull();
  // The docked chat beside the Note is about 330px; the main chat is far wider.
  expect(Number(block![1])).toBeGreaterThanOrEqual(400);
  expect(Number(block![1])).toBeLessThanOrEqual(560);
  const narrow = block![2];
  expect(narrow).toMatch(/\.pin-chip:has\(\.pin-chip-status\) \.pin-chip-icon > :not\(\.pin-chip-dot\) \{ display: none; \}/);
  expect(narrow).toMatch(/\.pin-chip-dot \{ position: static;/);
  // Only chips with a value lose the icon (a value-less chip would be empty).
  for (const rule of narrow.trim().split("\n")) expect(rule.trim()).toMatch(/^\.pin-chip:has\(\.pin-chip-status\)/);
  // Outside the query the icon is still drawn as before.
  expect(css.replace(block![0], "")).toMatch(/\.pin-chip-icon \{\n\s+position: relative; flex: none; width: 16px;/);
});
