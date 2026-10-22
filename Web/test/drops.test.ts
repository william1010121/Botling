/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchFileDrops } from "../src/drops";

// jsdom has no DragEvent: a plain event carrying a dataTransfer and relatedTarget is enough here.
function drag(type: string, target: EventTarget, extra: { files?: File[]; relatedTarget?: EventTarget | null; types?: string[] } = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const files = extra.files ?? [];
  Object.defineProperty(event, "dataTransfer", { value: { types: extra.types ?? ["Files"], files } });
  Object.defineProperty(event, "relatedTarget", { value: extra.relatedTarget ?? null });
  target.dispatchEvent(event);
  return event;
}

let stop: () => void = () => {};
const taken: File[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<div id="list"><p id="a">a</p><p id="b">b</p></div><div id="box"></div>`;
  document.body.classList.remove("dropping");
  taken.length = 0;
  stop = watchFileDrops(document.body, (file) => taken.push(file));
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

const outlined = () => document.body.classList.contains("dropping");

describe("the chat's file drop outline", () => {
  it("shows while files are dragged over the chat and drops attach them", () => {
    drag("dragover", document.getElementById("a")!);
    expect(outlined()).toBe(true);
    // Moving between the chat's own parts keeps it.
    drag("dragleave", document.getElementById("a")!, { relatedTarget: document.getElementById("b") });
    expect(outlined()).toBe(true);
    const file = new File(["x"], "x.txt");
    drag("drop", document.getElementById("b")!, { files: [file] });
    expect(outlined()).toBe(false);
    expect(taken).toEqual([file]);
  });

  it("clears when a part of the page takes the drop itself and stops it", () => {
    const box = document.getElementById("box")!;
    // The report box takes pictures dropped on it (pictures.ts) and stops the drop there.
    box.addEventListener("drop", (event) => { event.preventDefault(); event.stopPropagation(); });
    drag("dragover", document.getElementById("a")!);
    drag("dragleave", document.getElementById("a")!, { relatedTarget: box });
    drag("drop", box, { files: [new File(["x"], "x.png")] });
    expect(outlined()).toBe(false);
    expect(taken).toEqual([]);
  });

  it("clears when the drag leaves the window", () => {
    drag("dragover", document.getElementById("a")!);
    drag("dragleave", document.getElementById("a")!, { relatedTarget: null });
    expect(outlined()).toBe(false);
  });

  it("clears when the drag ends, the window loses focus, or the mouse moves with no button held", () => {
    drag("dragover", document.getElementById("a")!);
    drag("dragend", document.getElementById("a")!);
    expect(outlined()).toBe(false);

    drag("dragover", document.getElementById("a")!);
    window.dispatchEvent(new Event("blur"));
    expect(outlined()).toBe(false);

    drag("dragover", document.getElementById("a")!);
    document.getElementById("a")!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 0 }));
    expect(outlined()).toBe(false);
  });

  it("clears by itself when no drag has passed over for a while (the page never heard it end)", () => {
    drag("dragover", document.getElementById("a")!);
    vi.advanceTimersByTime(500);
    // Still dragging: each dragover keeps it.
    drag("dragover", document.getElementById("a")!);
    vi.advanceTimersByTime(500);
    expect(outlined()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(outlined()).toBe(false);
  });

  it("ignores drags that carry no files", () => {
    drag("dragover", document.getElementById("a")!, { types: ["text/plain"] });
    expect(outlined()).toBe(false);
  });
});
