import { post } from "./bridge";
import { escapeRegExp, shared } from "./contract";
import { t } from "./i18n";
import { isComposingEnter, isComposingKey } from "./ime";
import { escapeHTML } from "./util";
import { mediaSrc } from "./markdown";

/** Swift's `ImageFile.extensions`: the pictures it lets the lightbox hand to Preview. */
const imageExtensions = new RegExp(`\\.(${shared.imageExtensions.map(escapeRegExp).join("|")})$`, "i");

/** A picture the chat can show itself, rather than a page or file that opens in a window. */
export function isImageURL(url: string): boolean {
  if (/^data:image\//i.test(url)) return true;
  return imageExtensions.test(url.split(/[?#]/)[0]);
}

let current: { box: HTMLElement; restore: Element | null; cleanup: () => void } | null = null;

/**
 * Shows a picture over the chat, dimmed behind it: fit to the window with its caption below.
 * 2026-11-10: it zooms smoothly (the wheel, a trackpad pinch, + / - / 0, around the pointer) and pans by dragging, the
 * picture always inside the stage. Clicking the picture toggles fit and 100%; Esc, ✕ or a click outside it closes it.
 * (It used to have only fit and "actual": max-width removed, so a wide picture ran off the stage and was cut.)
 */
/** `shown`: where the picture clicked was loaded from (its line's copy), when that is known. */
export function openLightbox(url: string, label: string, shown?: string): void {
  closeLightbox();
  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label || t("lightbox.picture"));
  const openWords = escapeHTML(t("lightbox.openInPreview"));
  const revealWords = escapeHTML(t("lightbox.showInFinder"));
  // A file on disk: 1.x's file:// URL, or Botling 2's chat-origin attachment (`botling-chat://chat/attachment/…`).
  const local = url.startsWith("file:") || url.startsWith("botling-chat://chat/attachment/");
  box.innerHTML = `
    <div class="lightbox-bar">
      <output class="lightbox-zoom" aria-live="polite"></output>
      <button class="lightbox-open" type="button" title="${openWords}" data-url="${escapeHTML(url)}">${openWords}</button>
      ${local ? `<button class="lightbox-reveal" type="button" title="${revealWords}" data-url="${escapeHTML(url)}">${revealWords}</button>` : ""}
      <button class="lightbox-close" type="button" aria-label="${escapeHTML(t("common.close"))}" title="${escapeHTML(t("lightbox.closeEsc"))}">✕</button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-image" alt="" draggable="false"></div>
    <div class="lightbox-caption"></div>`;
  const image = box.querySelector<HTMLImageElement>(".lightbox-image")!;
  image.src = shown || mediaSrc(url);
  image.alt = label;
  const caption = box.querySelector<HTMLElement>(".lightbox-caption")!;
  caption.textContent = label;
  caption.hidden = label === "";
  const zoom = attachZoom(box, box.querySelector<HTMLElement>(".lightbox-stage")!, image, box.querySelector<HTMLElement>(".lightbox-zoom")!);

  box.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    event.stopPropagation();
    // The click that ends a drag neither zooms nor closes.
    if (zoom.wasDrag()) return;
    if (target === image) {
      zoom.toggle(event.clientX, event.clientY);
    } else if (target.closest(".lightbox-close")) {
      closeLightbox();
    } else if (target.closest(".lightbox-open")) {
      post({ type: "openExternal", url, ...(shown ? { shown } : {}) });
    } else if (target.closest(".lightbox-reveal")) {
      post({ type: "revealFile", url, ...(shown ? { shown } : {}) });
    } else if (!target.closest(".lightbox-bar, .lightbox-caption")) {
      closeLightbox();
    }
  });

  const restore = document.activeElement;
  // Over an open modal dialog (a plugin's, such as a summary's sources) it goes inside it, or the dialog would cover it.
  ([...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1) ?? document.body).append(box);
  const close = box.querySelector<HTMLButtonElement>(".lightbox-close")!;
  const onKey = (event: KeyboardEvent) => {
    if (!box.isConnected) { closeLightbox(false); return; }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeLightbox();
    } else if (!event.altKey && !event.ctrlKey && (event.key === "0" || event.key === "=" || event.key === "+" || event.key === "-")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "0") zoom.fit();
      else zoom.zoomBy(event.key === "-" ? 1 / 1.25 : 1.25);
    } else if (event.key === "Tab") {
      const buttons = Array.from(box.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (!box.contains(document.activeElement) ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      event.stopPropagation();
    }
  };
  const onFocus = (event: FocusEvent) => {
    if (!box.isConnected) { closeLightbox(false); return; }
    if (!box.contains(event.target as Node)) close.focus();
  };
  // Both supported hosts are direct body children. Observe removals without watching
  // every streaming message mutation; guards above also cover synchronous removal.
  const removal = new MutationObserver(() => {
    if (!box.isConnected) closeLightbox(false);
  });
  removal.observe(box.parentNode!, { childList: true });
  if (box.parentNode !== document.body) removal.observe(document.body, { childList: true });
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocus, true);
  current = { box, restore, cleanup: () => {
    zoom.dispose();
    removal.disconnect();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocus, true);
  } };
  close.focus();
}

interface Zoom {
  fit(): void;
  toggle(clientX: number, clientY: number): void;
  zoomBy(factor: number): void;
  /** True once, right after a drag ended: the click it makes is not a click. */
  wasDrag(): boolean;
  dispose(): void;
}

/** How far zoom-in goes, as a multiple of the picture's own pixels. */
const MAX_ZOOM = 8;

/**
 * Zoom and pan for the lightbox's picture: drawn at its natural size and placed with one transform
 * (translate, then scale from the top-left corner), so any scale is possible and nothing reflows. Zoom
 * out stops at the fitted size (never above 100% for a small picture); a picture smaller than the stage
 * is centred on that axis, a larger one can be panned only until its edge meets the stage's edge.
 */
function attachZoom(box: HTMLElement, stage: HTMLElement, image: HTMLImageElement, label: HTMLElement): Zoom {
  let x = 0, y = 0, s = 1, fitted = true, loaded = false;
  let drag: { id: number; startX: number; startY: number; fromX: number; fromY: number; moved: boolean } | null = null;
  let dragEnded = false;
  const natural = () => ({ w: image.naturalWidth || 1, h: image.naturalHeight || 1 });
  const fitScale = () => {
    const { w, h } = natural();
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!sw || !sh) return 1;
    return Math.min(sw / w, sh / h, 1);
  };
  const place = (nx: number, ny: number, ns: number) => {
    const { w, h } = natural();
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const min = fitScale();
    s = Math.min(Math.max(ns, min), Math.max(min, MAX_ZOOM));
    const pw = w * s, ph = h * s;
    x = pw <= sw ? (sw - pw) / 2 : Math.min(0, Math.max(sw - pw, nx));
    y = ph <= sh ? (sh - ph) / 2 : Math.min(0, Math.max(sh - ph, ny));
    fitted = Math.abs(s - min) < 1e-6;
    image.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    label.textContent = `${Math.round(s * 100)}%`;
    box.classList.toggle("zoomed", !fitted);
  };
  /** Zoom to `ns` keeping the picture's point under (cx, cy), stage coordinates, where it is. */
  const zoomAt = (ns: number, cx: number, cy: number) => {
    if (!loaded) return;
    const px = (cx - x) / s, py = (cy - y) / s;
    const min = fitScale();
    const next = Math.min(Math.max(ns, min), Math.max(min, MAX_ZOOM));
    place(cx - px * next, cy - py * next, next);
  };
  const local = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect();
    return { cx: clientX - r.left, cy: clientY - r.top };
  };
  const fit = () => { if (loaded) place(0, 0, fitScale()); };
  const onLoad = () => {
    loaded = true;
    const { w, h } = natural();
    image.style.width = `${w}px`;
    image.style.height = `${h}px`;
    image.style.visibility = "";
    fit();
  };
  image.style.visibility = "hidden";
  image.addEventListener("load", onLoad);
  image.addEventListener("error", () => { image.style.visibility = ""; });
  if (image.complete && image.naturalWidth) onLoad();

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!loaded) return;
    const line = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    const dx = event.deltaX * line, dy = event.deltaY * line;
    // A trackpad's sideways swipe pans; a pinch (ctrl + wheel), ⌘ + wheel and the wheel itself zoom.
    if (!event.ctrlKey && !event.metaKey && Math.abs(dx) > Math.abs(dy)) { place(x - dx, y - dy, s); return; }
    const { cx, cy } = local(event.clientX, event.clientY);
    zoomAt(s * Math.exp(-dy * (event.ctrlKey ? 0.01 : 0.002)), cx, cy);
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || !loaded) return;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, fromX: x, fromY: y, moved: false };
    dragEnded = false;
  };
  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      box.classList.add("dragging");
      try { stage.setPointerCapture(drag.id); } catch { /* not supported */ }
    }
    event.preventDefault();
    place(drag.fromX + dx, drag.fromY + dy, s);
  };
  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.id) return;
    dragEnded = drag.moved;
    try { stage.releasePointerCapture(drag.id); } catch { /* not captured */ }
    drag = null;
    box.classList.remove("dragging");
  };
  const onResize = () => { if (!loaded) return; if (fitted) fit(); else place(x, y, s); };
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  resize?.observe(stage);
  window.addEventListener("resize", onResize);

  return {
    fit,
    toggle(clientX, clientY) {
      if (!loaded) return;
      const min = fitScale();
      if (!fitted) { fit(); return; }
      const { cx, cy } = local(clientX, clientY);
      zoomAt(min < 1 ? 1 : Math.min(MAX_ZOOM, min * 2), cx, cy);
    },
    zoomBy(factor) { zoomAt(s * factor, stage.clientWidth / 2, stage.clientHeight / 2); },
    wasDrag() { const was = dragEnded; dragEnded = false; return was; },
    dispose() { resize?.disconnect(); window.removeEventListener("resize", onResize); },
  };
}

export function closeLightbox(restoreFocus = true): void {
  if (!current) return;
  const { box, restore, cleanup } = current;
  current = null;
  cleanup();
  box.remove();
  if (restoreFocus && restore instanceof HTMLElement && restore.isConnected) restore.focus();
}

/** Opens a picture in the lightbox; anything else (a page, a file, a link) goes to Swift as before. */
export function openMedia(url: string, label: string, shown?: string): void {
  if (isImageURL(url)) openLightbox(url, label, shown);
  else post({ type: "openURL", url, label });
}

const installed = new WeakSet<Document>();

/** Chips, images and file chips: pictures open in the lightbox, the rest outside the page. */
export function handleMediaClicks(root: Document): void {
  if (installed.has(root)) return;
  installed.add(root);
  root.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-url]");
    if (!target) return;
    event.preventDefault();
    const url = target.dataset.url!;
    const label = target.dataset.label || target.textContent?.trim() || "";
    // A picture in the chat opens as the one it shows (its line's), not whatever the path holds now.
    openMedia(url, label, target instanceof HTMLImageElement ? target.getAttribute("src") ?? undefined : undefined);
  });
  root.addEventListener("keydown", (event) => {
    if (isComposingKey(event) || isComposingEnter(event)) return;
    if (!(event.target instanceof Element)) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('img.media[role="button"][data-url], img.thumb[role="button"][data-url]');
    if (!target || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    if (!event.repeat) target.click();
  });
}
