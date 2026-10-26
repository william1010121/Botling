import { post } from "./bridge";
import { escapeRegExp, shared } from "./contract";
import { t } from "./i18n";
import { escapeHTML } from "./util";
import { mediaSrc } from "./markdown";

/** Swift's `ImageFile.extensions`: the pictures it lets the lightbox hand to Preview. */
const imageExtensions = new RegExp(`\\.(${shared.imageExtensions.map(escapeRegExp).join("|")})$`, "i");

/** A picture the chat can show itself, rather than a page or file that opens in a window. */
export function isImageURL(url: string): boolean {
  if (/^data:image\//i.test(url)) return true;
  return imageExtensions.test(url.split(/[?#]/)[0]);
}

let current: { box: HTMLElement; restore: Element | null } | null = null;

/**
 * Shows a picture over the chat, dimmed behind it: fit to the window with its caption below.
 * Clicking the picture toggles full size; Esc, ✕ or a click outside it closes it.
 */
export function openLightbox(url: string, label: string): void {
  closeLightbox();
  const box = document.createElement("div");
  box.className = "lightbox";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", label || t("lightbox.picture"));
  const openWords = escapeHTML(t("lightbox.openInPreview"));
  const revealWords = escapeHTML(t("lightbox.showInFinder"));
  box.innerHTML = `
    <div class="lightbox-bar">
      <button class="lightbox-open" type="button" title="${openWords}">${openWords}</button>
      ${url.startsWith("file:") ? `<button class="lightbox-reveal" type="button" title="${revealWords}">${revealWords}</button>` : ""}
      <button class="lightbox-close" type="button" aria-label="${escapeHTML(t("common.close"))}" title="${escapeHTML(t("lightbox.closeEsc"))}">✕</button>
    </div>
    <div class="lightbox-stage"><img class="lightbox-image" alt=""></div>
    <div class="lightbox-caption"></div>`;
  const image = box.querySelector<HTMLImageElement>(".lightbox-image")!;
  image.src = mediaSrc(url);
  image.alt = label;
  const caption = box.querySelector<HTMLElement>(".lightbox-caption")!;
  caption.textContent = label;
  caption.hidden = label === "";

  box.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    event.stopPropagation();
    if (target === image) {
      box.classList.toggle("actual");
    } else if (target.closest(".lightbox-close")) {
      closeLightbox();
    } else if (target.closest(".lightbox-open")) {
      post({ type: "openExternal", url });
    } else if (target.closest(".lightbox-reveal")) {
      post({ type: "revealFile", url });
    } else if (!target.closest(".lightbox-bar, .lightbox-caption")) {
      closeLightbox();
    }
  });

  const restore = document.activeElement;
  (document.querySelector("dialog.summary-source-viewer[open]") ?? document.body).append(box);
  current = { box, restore };
  box.querySelector<HTMLButtonElement>(".lightbox-close")!.focus();
}

export function closeLightbox(): void {
  if (!current) return;
  const { box, restore } = current;
  current = null;
  box.remove();
  if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
}

/** Opens a picture in the lightbox; anything else (a page, a file, a link) goes to Swift as before. */
export function openMedia(url: string, label: string): void {
  if (isImageURL(url)) openLightbox(url, label);
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
    openMedia(url, label);
  });
  root.addEventListener("keydown", (event) => {
    if (current && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeLightbox();
    }
  }, true);
}
