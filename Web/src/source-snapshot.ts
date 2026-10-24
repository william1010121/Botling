/** Runs only in an already existing live card: serialize its current DOM, never instantiate it again. */
export const sourceSnapshotScript = `
window.addEventListener('message', (event) => {
  if (event.source !== parent || !event.data || typeof event.data.ccbSourceSnapshot !== 'string') return;
  const copy = document.documentElement.cloneNode(true);
  const originalControls = document.querySelectorAll('input,textarea,select');
  copy.querySelectorAll('input,textarea,select').forEach((control, i) => {
    const original = originalControls[i];
    if (control.tagName === 'INPUT') {
      control.setAttribute('value', original.value);
      if (original.checked) control.setAttribute('checked',''); else control.removeAttribute('checked');
    } else if (control.tagName === 'TEXTAREA') control.textContent = original.value;
    else [...control.options].forEach((option, index) => {
      if (original.options[index].selected) option.setAttribute('selected',''); else option.removeAttribute('selected');
    });
  });
  const canvases = document.querySelectorAll('canvas');
  copy.querySelectorAll('canvas').forEach((canvas, i) => {
    try { const image = document.createElement('img'); image.src = canvases[i].toDataURL(); image.style.cssText = canvas.style.cssText; image.width = canvases[i].width; image.height = canvases[i].height; canvas.replaceWith(image); } catch { canvas.remove(); }
  });
  copy.querySelectorAll('script,iframe,object,embed,base,meta[http-equiv],link[rel="preload"],link[rel="modulepreload"]').forEach(node => node.remove());
  copy.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ['href','action','formaction','srcdoc','autofocus','contenteditable'].includes(attr.name)) node.removeAttribute(attr.name);
    if (node.matches('input,button,textarea,select')) node.setAttribute('disabled','');
    if (node.matches('video,audio')) { node.removeAttribute('autoplay'); node.removeAttribute('src'); }
  });
  parent.postMessage({ccb:'sourceSnapshot', request:event.data.ccbSourceSnapshot, html:'<!doctype html>'+copy.outerHTML, height:Math.ceil(document.documentElement.scrollHeight)}, '*');
});`;

export interface SourceSnapshot { html: string; height: number; }
let serial = 0;

/** A snapshot response is accepted from the exact existing frame and request only. */
export function requestSourceSnapshot(frame: HTMLIFrameElement, timeout = 800): Promise<SourceSnapshot | null> {
  const source = frame.contentWindow;
  if (!source) return Promise.resolve(null);
  const request = `source-${++serial}`;
  return new Promise(resolve => {
    const finish = (value: SourceSnapshot | null) => { clearTimeout(timer); window.removeEventListener("message", receive); resolve(value); };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== source || data?.ccb !== "sourceSnapshot" || data.request !== request) return;
      if (typeof data.html !== "string" || data.html.length > 8_000_000) { finish(null); return; }
      finish({ html: data.html, height: Number.isFinite(data.height) ? Math.max(1, data.height) : 240 });
    };
    const timer = setTimeout(() => finish(null), timeout);
    window.addEventListener("message", receive);
    source.postMessage({ ccbSourceSnapshot: request }, "*");
  });
}

/** Defense in depth: no executable child, navigation or enabled input survives the static view. */
export function staticSourcePage(html: string, quote?: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,iframe,object,embed,base,meta[http-equiv],link").forEach(node => node.remove());
  for (const node of doc.querySelectorAll("*")) {
    for (const attr of [...node.attributes]) if (/^on/i.test(attr.name) || ["href", "action", "formaction", "srcdoc", "autofocus", "contenteditable"].includes(attr.name)) node.removeAttribute(attr.name);
    if (node.matches("input,button,textarea,select")) node.setAttribute("disabled", "");
    if (node.matches("audio,video")) { node.removeAttribute("src"); node.removeAttribute("autoplay"); }
  }
  if (quote) {
    const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walk.nextNode())) {
      if (node.parentElement?.closest("style,script")) continue;
      const at = node.textContent?.indexOf(quote) ?? -1;
      if (at < 0) continue;
      const range = doc.createRange(); range.setStart(node, at); range.setEnd(node, at + quote.length);
      const mark = doc.createElement("mark"); mark.style.cssText = "background:rgba(76,141,255,.3);color:inherit;border-radius:4px";
      range.surroundContents(mark); break;
    }
  }
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob: file: ccb-preview: https: http:; style-src 'unsafe-inline'; font-src data:";
  doc.head.prepend(csp);
  const style = doc.createElement("style");
  style.textContent = "html,body{overflow:hidden!important}*{animation:none!important;transition:none!important;caret-color:transparent!important}button,input,select,textarea{pointer-events:none!important}mark{background:rgba(76,141,255,.3);color:inherit}";
  doc.head.append(style);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
