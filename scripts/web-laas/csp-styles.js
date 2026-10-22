// web-laas's preview, cards and toasts style themselves with <style> elements. In Chrome its
// isolated world is exempt from the page's Content-Security-Policy; a WKContentWorld is not, so on
// a page whose `style-src` allows no inline styles those elements stay empty. Here (esbuild
// `inject`, in the app's world only: its DOM prototypes are its own, the page's are untouched)
// a <style> the page refused is given to its document or shadow root as a constructed stylesheet,
// which `style-src` does not govern, and taken back when the element is removed.

const adopted = new WeakMap(); // <style> → [root, CSSStyleSheet]

function adopt(node) {
  if (!(node instanceof HTMLStyleElement) || node.sheet || adopted.has(node)) return;
  const root = node.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(node.textContent ?? "");
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    adopted.set(node, [root, sheet]);
  } catch {}
}

function release(node) {
  const entry = adopted.get(node);
  if (!entry) return;
  adopted.delete(node);
  const [root, sheet] = entry;
  root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
}

if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in Document.prototype && !globalThis.__ccbLaasCspStyles) {
  globalThis.__ccbLaasCspStyles = true;
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    for (const name of ["append", "prepend", "appendChild", "insertBefore"]) {
      const original = proto[name];
      if (typeof original !== "function") continue;
      proto[name] = function (...args) {
        const result = original.apply(this, args);
        for (const arg of name === "append" || name === "prepend" ? args : args.slice(0, 1)) adopt(arg);
        return result;
      };
    }
  }
  const remove = Element.prototype.remove;
  Element.prototype.remove = function () {
    release(this);
    return remove.call(this);
  };
}
