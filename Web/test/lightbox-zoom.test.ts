/// <reference types="node" />
// The lightbox's zoom (2026-11-10): it used to have only two states, fit and "actual" (max-width removed, so a wide
// picture ran off the stage and was cut). Now it zooms smoothly with the wheel and a trackpad pinch around the pointer,
// pans by dragging, and the picture always stays reachable inside the stage.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeLightbox, openLightbox } from "../src/lightbox";

const STAGE = { w: 1000, h: 600 };
const NATURAL = { w: 2164, h: 363 };

function open(): { box: HTMLElement; stage: HTMLElement; image: HTMLImageElement } {
  openLightbox("file:///tmp/onedc_simple.png", "OneDC");
  const box = document.querySelector<HTMLElement>(".lightbox")!;
  const stage = box.querySelector<HTMLElement>(".lightbox-stage")!;
  const image = box.querySelector<HTMLImageElement>(".lightbox-image")!;
  Object.defineProperty(stage, "clientWidth", { configurable: true, value: STAGE.w });
  Object.defineProperty(stage, "clientHeight", { configurable: true, value: STAGE.h });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: STAGE.w, bottom: STAGE.h, width: STAGE.w, height: STAGE.h, x: 0, y: 0, toJSON() {} });
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: NATURAL.w });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: NATURAL.h });
  image.dispatchEvent(new Event("load"));
  return { box, stage, image };
}

/** The picture's translate and scale, read back from its transform. */
function view(image: HTMLImageElement): { x: number; y: number; s: number } {
  const m = /translate\((-?[\d.e+-]+)px, (-?[\d.e+-]+)px\) scale\(([\d.e+-]+)\)/.exec(image.style.transform);
  expect(m, `transform: ${image.style.transform}`).not.toBeNull();
  return { x: Number(m![1]), y: Number(m![2]), s: Number(m![3]) };
}

function wheel(target: HTMLElement, deltaY: number, at = { x: 500, y: 300 }, extra: WheelEventInit = {}): void {
  target.dispatchEvent(new WheelEvent("wheel", { deltaY, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, ...extra }));
}

function pointer(target: HTMLElement, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: 1 });
  target.dispatchEvent(event);
}

beforeEach(() => { closeLightbox(); document.body.innerHTML = ""; });
afterEach(() => closeLightbox());

describe("lightbox zoom", () => {
  it("opens fitted and centred inside the stage, never wider than it", () => {
    const { image } = open();
    const v = view(image);
    expect(v.s).toBeCloseTo(STAGE.w / NATURAL.w, 5);
    expect(v.x).toBeCloseTo(0, 5);
    expect(v.y).toBeCloseTo((STAGE.h - NATURAL.h * v.s) / 2, 5);
  });

  it("zooms smoothly with the wheel and a pinch (many steps, not two), around the pointer", () => {
    const { stage, image } = open();
    const scales = [view(image).s];
    for (let i = 0; i < 4; i++) { wheel(stage, -40); scales.push(view(image).s); }
    wheel(stage, -10, { x: 500, y: 300 }, { ctrlKey: true }); // a trackpad pinch arrives as ctrl + wheel
    scales.push(view(image).s);
    expect(new Set(scales.map((s) => s.toFixed(4))).size).toBe(scales.length);
    for (let i = 1; i < scales.length; i++) expect(scales[i]).toBeGreaterThan(scales[i - 1]!);
    // The point under the pointer stays put.
    const before = view(image);
    const px = (500 - before.x) / before.s;
    wheel(stage, -40, { x: 500, y: 300 });
    const after = view(image);
    expect((500 - after.x) / after.s).toBeCloseTo(px, 3);
    // Zooming out stops at the fitted size.
    for (let i = 0; i < 60; i++) wheel(stage, 200);
    expect(view(image).s).toBeCloseTo(STAGE.w / NATURAL.w, 5);
  });

  it("pans by dragging, and the picture cannot be dragged out of sight", () => {
    const { stage, image } = open();
    for (let i = 0; i < 10; i++) wheel(stage, -100);
    const start = view(image);
    expect(NATURAL.w * start.s).toBeGreaterThan(STAGE.w);
    pointer(image, "pointerdown", 500, 300);
    pointer(image, "pointermove", 400, 300);
    pointer(image, "pointerup", 400, 300);
    expect(view(image).x).toBeCloseTo(start.x - 100, 3);
    // Dragging far right: the left edge stops at the stage's left edge (nothing beyond the picture is shown).
    pointer(image, "pointerdown", 100, 300);
    pointer(image, "pointermove", 5000, 300);
    pointer(image, "pointerup", 5000, 300);
    expect(view(image).x).toBeCloseTo(0, 5);
    // A drag is not a click: the lightbox stays open and the zoom stays.
    image.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".lightbox")).not.toBeNull();
  });

  it("a click on the picture toggles between fit and 100%, and 0 fits again", () => {
    const { image } = open();
    image.dispatchEvent(new MouseEvent("click", { clientX: 500, clientY: 300, bubbles: true }));
    expect(view(image).s).toBeCloseTo(1, 5);
    expect(document.querySelector(".lightbox")).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true }));
    expect(view(image).s).toBeCloseTo(STAGE.w / NATURAL.w, 5);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "=", bubbles: true }));
    expect(view(image).s).toBeGreaterThan(STAGE.w / NATURAL.w);
  });

  it("shows the zoom as a percentage in the bar", () => {
    const { stage, box } = open();
    const label = box.querySelector(".lightbox-zoom")!;
    expect(label.textContent).toBe(`${Math.round((STAGE.w / NATURAL.w) * 100)}%`);
    wheel(stage, -100);
    expect(label.textContent).not.toBe(`${Math.round((STAGE.w / NATURAL.w) * 100)}%`);
  });
});
