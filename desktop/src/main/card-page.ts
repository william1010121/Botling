// Content Security Policies for the botling-card:// pages main serves (component, panel and result pages)
// and the types of files a result page may load beside it.

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

/**
 * A result page in a preview card's frame (1.x served it to WebKit with no policy): its own files and pictures
 * beside it (inside its artifacts folder), inline scripts and styles, and what it loads from https (charts and
 * fonts from a CDN). No frames, forms, plain http or other app URLs. The frame is still sandboxed (opaque origin).
 */
export const PREVIEW_CSP = [
  "sandbox allow-scripts",
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
 * the plugin's module (its own source text, given by the core) can be imported, and frames of card pages
 * (botling-card://page/<token>, the tiles `ccb.tile` asks for; main serves each token once, under
 * COMPONENT_CSP, so a tile frames nothing further). Still no network, forms or workers; the frame is
 * `sandbox="allow-scripts"` (opaque origin).
 */
export const PAGE_URL = "botling-card://page/";

/**
 * Whether a frame may load `url` as a tile of a plugin's panel (`ccb.tile`): a component page (never a panel's)
 * in a frame whose parent is a panel page the app page itself holds, started by that panel (or by nothing). `kind`
 * is what main served under a token. Every other card page loads only in the app page or the chat page.
 */
export function tileNavigation(url: string, parent: { url: string; childOfApp: boolean } | null, byParent: boolean, kind: (token: string) => "panel" | "component" | null): boolean {
  const token = (page: string) => (page.startsWith(PAGE_URL) ? page.slice(PAGE_URL.length).split(/[?#/]/)[0] || null : null);
  const tile = token(url);
  const panel = parent ? token(parent.url) : null;
  return !!tile && !!panel && !!parent?.childOfApp && byParent && kind(tile) === "component" && kind(panel) === "panel";
}

export const PANEL_CSP = COMPONENT_CSP
  .replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' blob:")
  .replace("frame-src botling-card://preview", "frame-src botling-card://preview botling-card://page/");
