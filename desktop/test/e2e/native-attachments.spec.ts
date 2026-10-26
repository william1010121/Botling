// Pictures into the chat with the native editor host (the chat page in its own WebContents): the +
// picker, a pasted screenshot and a dropped one all wait in the input box and go with the message.
// A real screenshot is megabytes of base64, over the editor wire's 1 MB cap for other messages.
// Hidden only: the paste and drop are synthetic DOM events in the page, no window is shown or focused.
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { launch, MAIN } from "./launch";

/** A 4×4 red PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC", "base64");
/** The same picture made screenshot-sized (bytes after IEND are ignored by decoders). */
const BIG = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 7)]);

test("picked, pasted and dropped pictures reach the input box and go with the message", async () => {
  test.setTimeout(60_000);
  const dataDir = tempDir("e2e-native-files");
  const outside = tempDir("e2e-native-outside");
  writeFileSync(join(outside, "red.png"), PNG);
  const input = join(dataDir, "claude-input.jsonl");
  const { app } = await launch({ dataDir, waitForState: false, env: { BOTLING_TEST_PICK: JSON.stringify([join(outside, "red.png")]), FAKE_CLAUDE_INPUT: input } });
  try {
    const editor = await until(() => app.context().pages().find((page) => page.url().includes("nativeHost=1")) ?? null, { what: "the native chat page" });
    await expect(editor.locator("html")).toHaveAttribute("data-chat", MAIN);
    const pending = editor.locator(".pending-files .pending");
    // The + button: main's picker (answered by BOTLING_TEST_PICK).
    await editor.locator(".composer button.plus").evaluate((el: HTMLElement) => el.click());
    await expect(pending).toHaveCount(1);
    // A screenshot pasted on the input box.
    await editor.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "Pasted.png", { type: "image/png" }));
      document.querySelector(".composer .cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, BIG.toString("base64"));
    await expect(pending).toHaveCount(2);
    // A screenshot dropped on the chat.
    await editor.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], "Dropped.png", { type: "image/png" }));
      document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    }, BIG.toString("base64"));
    await expect(pending).toHaveCount(3);
    await editor.locator(".composer button.send").first().evaluate((el: HTMLElement) => el.click());
    await expect(pending).toHaveCount(0);
    await expect(editor.locator(".row.user").last().locator(".attachments img")).toHaveCount(3);
    const folder = join(dataDir, "core", "main", "attachments");
    const kept = await until(() => (existsSync(folder) && readdirSync(folder).length === 3 ? readdirSync(folder) : null), { what: "three kept attachments" });
    for (const name of ["Pasted.png", "Dropped.png"]) expect(readFileSync(join(folder, kept.find((file) => file.endsWith(name))!)).equals(BIG)).toBe(true);
    // The head was told where they are and saw the pictures.
    const line = await until(() => (existsSync(input) ? readFileSync(input, "utf8").trim().split("\n").map((row) => JSON.parse(row)).filter((row) => row.text.includes("(Attachments:")) : []).at(-1) ?? null, { what: "the head's input" });
    expect(line.images).toEqual(["image/png", "image/png", "image/png"]);
  } finally {
    await app.close();
  }
});
