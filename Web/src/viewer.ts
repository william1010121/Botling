import { mathPlugin } from "../plugins/ccb-latex/src/math";
import { post } from "./bridge";
import { setLanguage, t } from "./i18n";
import { installImeGuard } from "./ime";
import { createMarkdown } from "./markdown";

/**
 * The file window for a .md file: the file drawn with the chat's own Markdown (raw HTML shown as
 * text, never run; script links dropped) and LaTeX, plus a Source toggle for the text as written.
 * The app hands the file over as `window.ccbDocument` before this script runs.
 */
export interface ViewerDocument {
  /** The file's text. */
  text: string;
  /** The file's own `file:` URL: relative pictures and links resolve against it. */
  base: string;
  /** The file name. */
  name: string;
  /** The language of the window's own words (Settings → General → Language); absent means English. */
  lang?: string | null;
}

installImeGuard(window);
const markdown = createMarkdown().use(mathPlugin);

/** A URL from the file made absolute against the file itself (`pics/a.png` → `file:///…/pics/a.png`). */
function resolve(url: string, base: string): string {
  if (url === "" || url.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** The file's Markdown as HTML, with relative pictures and links pointing beside the file. */
export function renderDocument(text: string, base: string): string {
  const template = document.createElement("template");
  template.innerHTML = markdown.render(text);
  for (const media of template.content.querySelectorAll<HTMLElement>("img.media, video.media")) {
    const src = media.getAttribute("src");
    if (src != null) media.setAttribute("src", resolve(src, base));
    if (media.dataset.url != null) media.dataset.url = resolve(media.dataset.url, base);
  }
  for (const link of template.content.querySelectorAll<HTMLElement>("a[data-url]")) {
    link.dataset.url = resolve(link.dataset.url!, base);
  }
  return template.innerHTML;
}

/** Draws `doc` into the page: the formatted file, the raw source (hidden) and the toggle. */
export function showDocument(doc: ViewerDocument): void {
  setLanguage(doc.lang);
  document.title = doc.name;
  document.body.classList.add("viewer");
  const bar = document.createElement("div");
  bar.className = "viewer-bar";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "source-toggle";
  toggle.textContent = t("viewer.source");
  toggle.setAttribute("aria-pressed", "false");
  bar.append(toggle);

  const article = document.createElement("article");
  article.className = "markdown";
  article.innerHTML = renderDocument(doc.text, doc.base);

  const source = document.createElement("pre");
  source.className = "source";
  source.textContent = doc.text;
  source.hidden = true;

  const page = document.createElement("main");
  page.className = "viewer-page";
  page.append(article, source);
  document.body.replaceChildren(bar, page);

  toggle.addEventListener("click", () => {
    const showSource = source.hidden;
    source.hidden = !showSource;
    article.hidden = showSource;
    toggle.textContent = showSource ? t("viewer.formatted") : t("viewer.source");
    toggle.setAttribute("aria-pressed", String(showSource));
  });

  // Links and pictures open like they do in the chat: web links in the browser, files in a window.
  article.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-url]");
    if (!target) return;
    event.preventDefault();
    const url = target.dataset.url!;
    if (url === "" || url.startsWith("#")) return;
    post({ type: "openURL", url, label: target.dataset.label || target.textContent?.trim() || "" });
  });
}

const given = (window as unknown as { ccbDocument?: ViewerDocument }).ccbDocument;
if (given) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => showDocument(given));
  else showDocument(given);
}
