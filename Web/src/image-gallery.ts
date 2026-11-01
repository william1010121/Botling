import { t } from "./i18n";

const isImage = (node: Node): node is HTMLImageElement =>
  node instanceof HTMLImageElement && node.matches('img.media[role="button"]');
const isSpace = (node: Node): boolean =>
  node.nodeType === Node.TEXT_NODE ? !node.textContent?.trim() : node instanceof HTMLBRElement;

/** Only operates inside one rendered Markdown piece; components and messages are boundaries. */
export function groupImages(root: HTMLElement): void {
  const paragraphs: { element: Element; nodes: Node[] }[] = [];
  // Unwrap image-only paragraphs so blank Markdown lines do not split a run.
  for (const child of Array.from(root.children)) {
    if (child.tagName === "P" && Array.from(child.childNodes).some(isImage)
      && Array.from(child.childNodes).every(node => isImage(node) || isSpace(node))) {
      const nodes = Array.from(child.childNodes);
      paragraphs.push({ element: child, nodes });
      child.replaceWith(...nodes);
    } else if (child.matches("p, blockquote, li, ul, ol")) groupImages(child as HTMLElement);
  }
  let run: HTMLImageElement[] = [];
  const flush = () => {
    if (run.length > 1) makeGallery(run);
    run = [];
  };
  for (const node of Array.from(root.childNodes)) {
    if (isImage(node)) run.push(node);
    else if (!isSpace(node)) flush();
  }
  flush();
  // A lone image retains its exact original paragraph and layout.
  for (const { element, nodes } of paragraphs) {
    if (nodes.every(node => node.parentNode === root)) {
      root.insertBefore(element, nodes[0]);
      element.append(...nodes);
    }
  }
}

/**
 * CSS height of the tallest loaded image as shown at the stage width (`cqw`), never upscaled and
 * capped like the image itself, so the pager does not jump between a wide and a tall image.
 */
export function stageReserve(sizes: readonly { width: number; height: number }[]): string {
  const heights = new Set(sizes.filter(size => size.width > 0 && size.height > 0)
    .map(size => `min(${size.height}px, var(--gallery-cap), ${+(size.height / size.width * 100).toFixed(2)}cqw)`));
  return heights.size ? `max(${[...heights].join(", ")})` : "";
}

function makeGallery(images: HTMLImageElement[]): void {
  const gallery = document.createElement("span");
  gallery.className = "image-gallery";
  gallery.tabIndex = 0;
  gallery.setAttribute("role", "group");
  gallery.setAttribute("aria-label", t("gallery.label"));
  const stage = document.createElement("span");
  stage.className = "image-gallery-stage";
  const caption = document.createElement("span");
  caption.className = "image-gallery-caption";
  const controls = document.createElement("span");
  controls.className = "image-gallery-controls";
  const previous = document.createElement("button");
  const next = document.createElement("button");
  const count = document.createElement("span");
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  for (const [button, label, icon] of [[previous, t("gallery.previous"), "←"], [next, t("gallery.next"), "→"]] as const) {
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = icon;
  }
  // Remove only the whitespace between grouped images, including Markdown hard breaks.
  for (let i = 0; i < images.length - 1; i++) {
    let node = images[i].nextSibling;
    while (node && node !== images[i + 1]) {
      const next = node.nextSibling;
      node.parentNode!.removeChild(node);
      node = next;
    }
  }
  images[0].before(gallery);
  // The caption sits in the stage so it stays under a short image instead of below the reserve.
  stage.append(...images, caption);
  controls.append(previous, count, next);
  gallery.append(stage, controls);
  // Reserve a caption line for every image when any has one, or the pager moves by that line.
  gallery.classList.toggle("captioned", images.some(image => image.alt));
  const sizes: { width: number; height: number }[] = [];
  const measure = (image: HTMLImageElement) => {
    if (!image.naturalWidth) return;
    sizes.push({ width: image.naturalWidth, height: image.naturalHeight });
    stage.style.setProperty("--image-reserve", stageReserve(sizes));
    // One image has shown, so the gallery is near the viewport: load the rest to settle the reserve.
    for (const other of images) other.loading = "eager";
  };
  for (const image of images) {
    if (image.complete) measure(image);
    image.addEventListener("load", () => measure(image));
  }
  let index = 0;
  const show = (target: number) => {
    index = Math.max(0, Math.min(images.length - 1, target));
    images.forEach((image, i) => { image.hidden = i !== index; });
    // Load the selected original even when the gallery itself is below the viewport.
    images[index].loading = "eager";
    caption.textContent = images[index].alt;
    caption.hidden = !caption.textContent;
    count.textContent = `${index + 1} / ${images.length}`;
    previous.setAttribute("aria-disabled", String(index === 0));
    next.setAttribute("aria-disabled", String(index === images.length - 1));
  };
  previous.addEventListener("click", () => show(index - 1));
  next.addEventListener("click", () => show(index + 1));
  gallery.addEventListener("keydown", event => {
    const target = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1
      : event.key === "Home" ? 0 : event.key === "End" ? images.length - 1 : null;
    if (target === null || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (document.activeElement instanceof HTMLImageElement) gallery.focus();
    show(target);
  });
  let start: { x: number; y: number } | null = null;
  let suppressClick = false;
  gallery.addEventListener("touchstart", event => {
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    suppressClick = false;
  }, { passive: true });
  gallery.addEventListener("touchcancel", () => { start = null; });
  gallery.addEventListener("touchend", event => {
    const touch = event.changedTouches[0];
    if (start && touch) {
      const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        show(index + (dx < 0 ? 1 : -1));
        suppressClick = true;
      }
    }
    start = null;
  });
  gallery.addEventListener("click", event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  // One step per trackpad gesture; vertical scrolling still belongs to the chat.
  let lastWheel = -Infinity;
  gallery.addEventListener("wheel", event => {
    if (event.ctrlKey || Math.abs(event.deltaX) < 8 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheel > 180) show(index + (event.deltaX > 0 ? 1 : -1));
    lastWheel = now;
  }, { passive: false });
  show(0);
}
