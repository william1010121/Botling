// The page a card frame loads from `botling-card://card/<messageId>/<cardId>`: the agent's HTML
// plus a tiny `ccb` runtime, under a CSP that lets its own inline script run but reach nothing —
// no network, no forms, no nested frames. The frame is also `sandbox="allow-scripts"` (opaque
// origin: no cookies, storage or access to the app's page) and has no preload, so `ccb` is all it
// has, and every `ccb` call is a postMessage that the renderer's broker checks.

export const CARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * A library component's page (Web/src's `componentPage`): its own inline scripts and styles run,
 * pictures come only as data:/blob: or from botling-card://image/ (pictures its data named), and
 * it reaches nothing else — no network, no frames, no forms, no workers.
 */
export const COMPONENT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: botling-card:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  // Only result pages (the 「網頁預覽卡片」 card's frame, Phase 5c): main serves files inside an artifacts folder there.
  "frame-src botling-card://preview",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const runtime = `<script>
(() => {
  let data = null;
  const listeners = [];
  window.addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || typeof event.data.ccbData !== 'string') return;
    try { data = JSON.parse(event.data.ccbData); } catch { return; }
    for (const fn of listeners) { try { fn(data); } catch (error) { console.error(error); } }
  });
  const post = (message) => parent.postMessage(message, '*');
  window.ccb = Object.freeze({
    get data() { return data; },
    onData(fn) { listeners.push(fn); if (data !== null) fn(data); },
    save(value) {
      const json = JSON.stringify(value);
      if (json === undefined || json === 'null') return Promise.reject(new Error('ccb.save needs data (not null or undefined).'));
      data = JSON.parse(json);
      post({ ccb: 'save', data: json });
      return Promise.resolve();
    },
    action(name, value) { post({ ccb: 'action', name: String(name), value: value == null ? '' : String(value) }); },
  });
  const size = () => post({ ccb: 'size', height: Math.min(4000, Math.ceil(document.documentElement.getBoundingClientRect().height)) });
  new ResizeObserver(size).observe(document.documentElement);
  addEventListener('load', size);
})();
</script>`;

const style = `<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: transparent; color: #EDEDF0; font: 14px/1.55 -apple-system, "PingFang TC", "Noto Sans TC", "Segoe UI", sans-serif; }
  body { padding: 12px 14px; }
  button { font: inherit; color: #EDEDF0; background: #2C2C33; border: 1px solid #2E2E35; border-radius: 10px; padding: 6px 12px; cursor: pointer; }
  button:hover { background: #33333B; }
  code { background: #111114; padding: 1px 5px; border-radius: 5px; }
  p { margin: 0 0 10px; color: #A0A0A8; }
</style>`;

export function cardPage(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CARD_CSP}">${style}${runtime}</head><body>${html}</body></html>`;
}

/**
 * A result page in a preview card's frame (1.x served it to WebKit with no policy): its own files and pictures
 * beside it (inside its artifacts folder), inline scripts and styles, and what it loads from https (charts and
 * fonts from a CDN). No frames, forms, plain http or other app URLs. The frame is still sandboxed (opaque origin).
 */
export const PREVIEW_CSP = [
  "default-src botling-card://preview",
  "object-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' botling-card://preview https:",
  "style-src 'unsafe-inline' botling-card://preview https:",
  "img-src botling-card://preview data: blob: https:",
  "font-src botling-card://preview data: https:",
  "media-src botling-card://preview data: blob: https:",
  "connect-src https:",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Types a result page and the files beside it are served as (1.x's PagePreview.mimeTypes). */
export const PREVIEW_TYPES: Record<string, string> = {
  html: "text/html", htm: "text/html", css: "text/css", js: "application/javascript", mjs: "application/javascript", json: "application/json",
  txt: "text/plain", csv: "text/plain", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", ico: "image/x-icon", heic: "image/heic", heif: "image/heif", avif: "image/avif", bmp: "image/bmp", tif: "image/tiff",
  tiff: "image/tiff", mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", mp3: "audio/mpeg",
  m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  aiff: "audio/aiff", aif: "audio/aiff", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", wasm: "application/wasm",
};

/**
 * A plugin panel's page (its web part in a sandboxed frame): as COMPONENT_CSP, plus `blob:` scripts so
 * the plugin's module (its own source text, given by the core) can be imported. Still no network,
 * frames, forms or workers; the frame is `sandbox="allow-scripts"` (opaque origin).
 */
export const PANEL_CSP = COMPONENT_CSP.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' blob:");
