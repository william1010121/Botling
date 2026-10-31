// What a capture's outline.json holds: the page's visible elements, each with its tag, id,
// classes, test ids and role, its own words (cut short) and where it is, in page order, with
// its depth. It is for writing a page reader's selectors without the page at hand. Run in the
// app's own world; it only reads the page. `return`s the JSON text (the body of an async function).
const MAX_ELEMENTS = 4000;
const MAX_TEXT = 160;
const SKIP = new Set(["script", "style", "noscript", "template", "link", "meta", "head"]);
const out = [];
const ownText = (element) => {
  let text = "";
  for (const child of element.childNodes) if (child.nodeType === 3) text += child.nodeValue;
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
};
const walk = (element, depth) => {
  if (out.length >= MAX_ELEMENTS) return;
  const tag = element.tagName.toLowerCase();
  if (SKIP.has(tag)) return;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  if (style.display === "none") return;
  if (visible) {
    const item = { depth, tag, rect: [Math.round(rect.x), Math.round(rect.y + scrollY), Math.round(rect.width), Math.round(rect.height)] };
    if (element.id) item.id = element.id;
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean) : [];
    if (classes.length) item.classes = classes.slice(0, 12);
    for (const name of ["data-testid", "data-test-id", "data-message-author-role", "data-message-id", "data-is-streaming", "role", "aria-label"]) {
      const value = element.getAttribute(name);
      if (value) (item.attributes = item.attributes || {})[name] = value.length > MAX_TEXT ? value.slice(0, MAX_TEXT - 1) + "…" : value;
    }
    const text = ownText(element);
    if (text) item.text = text;
    out.push(item);
  }
  for (const child of element.children) walk(child, depth + 1);
  if (element.shadowRoot) for (const child of element.shadowRoot.children) walk(child, depth + 1);
};
if (document.body) walk(document.body, 0);
return JSON.stringify({ url: location.href, title: document.title, viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY], truncated: out.length >= MAX_ELEMENTS, elements: out });
