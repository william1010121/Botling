import { afterEach, expect, it } from "vitest";
import { groupImages } from "../src/image-gallery";
import { renderMarkdown, setMediaSource } from "../src/markdown";
import { messageElement } from "../src/messages";
import { closeLightbox, handleMediaClicks } from "../src/lightbox";
import type { MessageView } from "../src/types";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
handleMediaClicks(document);
afterEach(() => { closeLightbox(); document.body.innerHTML = ""; setMediaSource(url => url); });
const a = '![First](file:///tmp/a.png)', b = '![Second](file:///tmp/b.png)';
function draw(text: string, extra: Partial<MessageView> = {}) {
  const row = messageElement({ id: "m", role: "bot", text, stamp: null, avatar: null, choices: null, chosen: null,
    answer: null, open: false, display: null, attachments: null, replyTo: null, replyPreview: null, openable: false, ...extra }, {});
  document.body.append(row); return row;
}
const visible = (row: Element) => [...row.querySelectorAll<HTMLImageElement>('img.media')].filter(image => !image.hidden);
const next = (row: Element) => row.querySelector<HTMLButtonElement>('[aria-label="Next image"]')!.click();
it('groups blank lines and hard breaks, retaining every original and alt; navigates and previews the selected image', () => {
  setMediaSource(url => 'http://localhost/media?url=' + encodeURIComponent(url));
  const row = draw(`${a}\n\n  \n${b}  \n![Third](file:///tmp/c.png)`);
  expect(row.querySelectorAll('.image-gallery')).toHaveLength(1);
  expect(row.querySelectorAll('img.media')).toHaveLength(3);
  expect(visible(row).map(i => i.alt)).toEqual(['First']);
  next(row);
  expect(visible(row).map(i => i.alt)).toEqual(['Second']);
  expect(row.querySelector('[role="status"]')?.textContent).toBe('2 / 3');
  expect(visible(row)[0].src).toContain('http://localhost/media?url=');
  visible(row)[0].click();
  expect(document.querySelector('.lightbox-caption')?.textContent).toBe('Second');
});
it('leaves a single image exactly unchanged', () => {
  const root = document.createElement('div'); root.innerHTML = renderMarkdown(a);
  const before = root.innerHTML; groupImages(root); expect(root.innerHTML).toBe(before);
});
it.each(['Text', '```js\nimage()\n```', '![Video](file:///tmp/movie.mp4)', '[Link](file:///tmp/photo.png)', '---', '> quoted text'])('keeps %s as a boundary', divider => {
  const row = draw(`${a}\n\n${b}\n\n${divider}\n\n${a}\n\n${b}`);
  expect(row.querySelectorAll('.image-gallery')).toHaveLength(2);
  expect(visible(row)).toHaveLength(2);
  next(row); expect(visible(row).map(i => i.alt)).toEqual(['Second', 'First']);
});
it('does not cross messages, component boundaries, or linked-image controls', () => {
  draw(a); draw(b); expect(document.querySelector('.image-gallery')).toBeNull();
  const row = draw(`${a}\n\n${b}`, { displays: [{ name: 'missing', data: '{}', at: a.length }] });
  expect(row.querySelector('.image-gallery')).toBeNull();
  const linked = draw(`${a}\n\n[${b}](https://example.com)\n\n${a}`);
  expect(linked.querySelector('.image-gallery')).toBeNull();
  expect(linked.querySelector('a img')).not.toBeNull();
});
it('supports focused arrows/home/end without moving focus onto a hidden image; endpoints remain stable', () => {
  const row = draw(`${a}\n\n${b}`), gallery = row.querySelector<HTMLElement>('.image-gallery')!;
  visible(row)[0].focus();
  visible(row)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(document.activeElement).toBe(gallery); expect(visible(row)[0].alt).toBe('Second');
  next(row); expect(visible(row)[0].alt).toBe('Second');
  gallery.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(visible(row)[0].alt).toBe('First');
  expect(row.querySelector('[aria-label="Previous image"]')?.getAttribute('aria-disabled')).toBe('true');
});
it('retains failed images and can navigate away; historical reconstruction restores all originals', () => {
  let row = draw(`${a}\n\n${b}`, { earlier: true });
  visible(row)[0].dispatchEvent(new Event('error'));
  next(row); expect(visible(row)[0].alt).toBe('Second');
  row.remove(); row = draw(`${a}\n\n${b}`, { earlier: true });
  expect(row.querySelectorAll('img.media')).toHaveLength(2); next(row); expect(visible(row)[0].alt).toBe('Second');
});
it('handles horizontal wheel while leaving vertical scrolling alone', () => {
  const row = draw(`${a}\n\n${b}`), gallery = row.querySelector<HTMLElement>('.image-gallery')!;
  const vertical = new WheelEvent('wheel', { deltaY: 80, cancelable: true }); gallery.dispatchEvent(vertical);
  expect(vertical.defaultPrevented).toBe(false); expect(visible(row)[0].alt).toBe('First');
  gallery.dispatchEvent(new WheelEvent('wheel', { deltaX: 80, cancelable: true })); expect(visible(row)[0].alt).toBe('Second');
});
it('keeps inline text between runs and preserves single images in mixed paragraphs', () => {
  const row = draw(`${a} ${b} divider ${a} ${b}\n\nSingle: ${a}`);
  expect(row.querySelectorAll('.image-gallery')).toHaveLength(2);
  expect(visible(row)).toHaveLength(3);
  expect(row.textContent).toContain('divider');
});
it('touch swipes navigate once and suppress their synthetic preview click', () => {
  const row = draw(`${a}\n\n${b}`), gallery = row.querySelector<HTMLElement>('.image-gallery')!;
  const touch = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, type === 'touchstart' ? 'touches' : 'changedTouches', { value: [{clientX: x, clientY: y}] });
    gallery.dispatchEvent(event);
  };
  touch('touchstart', 200, 100); touch('touchend', 100, 105);
  expect(visible(row)[0].alt).toBe('Second');
  visible(row)[0].click(); expect(document.querySelector('.lightbox')).toBeNull();
  touch('touchstart', 100, 100); touch('touchend', 110, 220);
  expect(visible(row)[0].alt).toBe('Second');
  visible(row)[0].click(); expect(document.querySelector('.lightbox')).not.toBeNull();
});
