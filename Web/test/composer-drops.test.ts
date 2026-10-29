import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer, sendFile } from "../src/composer";
import { watchFileDrops } from "../src/drops";
import { sent } from "../src/bridge";

let composer: Composer;
let stop: () => void;
let reads: Promise<void>[];
beforeEach(() => {
  document.body.innerHTML = "";
  sent.length = 0;
  reads = [];
  // Await real reads, including CodeMirror's asynchronous file-to-text insertion.
  const NativeReader = window.FileReader;
  vi.stubGlobal("FileReader", class extends NativeReader {
    constructor() {
      super();
      reads.push(new Promise((resolve) => this.addEventListener("loadend", () => resolve())));
    }
  });
  composer = new Composer(document.body);
  vi.spyOn(composer.view, "posAtCoords").mockReturnValue(0);
  stop = watchFileDrops(document.body, sendFile);
});
afterEach(() => {
  stop();
  composer.view.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function transfer(kind: "drop" | "paste", files: File[], formats: Record<string, string>, target = composer.view.contentDOM) {
  const event = new Event(kind, { bubbles: true, cancelable: true });
  Object.defineProperty(event, kind === "drop" ? "dataTransfer" : "clipboardData", {
    value: { files, types: [...(files.length ? ["Files"] : []), ...Object.keys(formats)],
      getData: (type: string) => formats[type === "Text" ? "text/plain" : type] ?? "" },
  });
  target.dispatchEvent(event);
  await Promise.all(reads);
  return event;
}
const attachments = () => sent.filter((action) => action.type === "addFileData");
const alternates: Record<string, string>[] = [{}, { "text/plain": "# alternate" }, { "text/plain": "# alternate", "text/html": "<h1>alternate</h1>" }];
describe("composer file drops", () => {
  it.each(alternates)("attaches Markdown once without inserting contents, formats %j", async (formats) => {
    composer.setText("Existing draft");
    const event = await transfer("drop", [new File(["# File contents"], "notes.md", { type: "text/markdown" })], formats);
    expect(composer.text).toBe("Existing draft");
    expect(attachments()).toEqual([{ type: "addFileData", name: "notes.md", base64: btoa("# File contents") }]);
    expect(event.defaultPrevented).toBe(true);
  });
  it("keeps deliberate Markdown text paste", async () => {
    await transfer("paste", [], { "text/plain": "# Pasted text", "text/html": "<h1>Pasted text</h1>" });
    expect(composer.text).toBe("# Pasted text");
    expect(attachments()).toEqual([]);
  });
  it("keeps text-only drag insertion", async () => {
    await transfer("drop", [], { "text/plain": "Dragged text" });
    expect(composer.text).toBe("Dragged text");
    expect(attachments()).toEqual([]);
  });
  it("attaches multiple ordinary files once from the editor", async () => {
    await transfer("drop", [new File(["picture"], "photo.png"), new File(["pdf"], "paper.pdf")], {});
    expect(composer.text).toBe("");
    expect(attachments().map((file) => file.name).sort()).toEqual(["paper.pdf", "photo.png"]);
  });
  it("keeps attachment drops outside the editor", async () => {
    await transfer("drop", [new File(["# Notes"], "notes.md")], {}, document.body);
    expect(composer.text).toBe("");
    expect(attachments()).toHaveLength(1);
  });
  it("keeps file paste attachment handling", async () => {
    await transfer("paste", [new File(["picture"], "photo.png")], { "text/plain": "alternate" });
    expect(composer.text).toBe("");
    expect(attachments()).toHaveLength(1);
  });
});
