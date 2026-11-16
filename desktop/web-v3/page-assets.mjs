// The non-code files the web-v3 page ships (fix-shell-hash-assets): ONE list, read by two parties.
//   - web-v3/build.mjs copies each entry of PAGE_ASSETS into the page's folder (`from` → `to`);
//   - fe-shell-manifest.mjs hashes the same files into `shell.hash` (a shell CSS-only change has to move it), via `shellAssetPaths`.
// So the two cannot drift apart for these files. A file the build reads that is NOT here (nor a plugin source, nor in node_modules, nor
// bundled by esbuild) is a drift: test/unit/shell-hash-assets.test.ts builds the page and fails on it.
//
// Not listed on purpose: the in-page plugins' own CSS (a plugin source: a plugin-only change must not move the shell hash) and files under
// node_modules (pdfjs-dist, katex: pinned by package-lock.json). Plain data and no imports, so any process can load it (jsdom included).

/**
 * Repo-relative `from`, the published name `to`, `tokens` (the build inlines `@import`s: the files they reach are part of the asset),
 * `append` (a repo-relative file whose bytes the build adds after this one).
 * @type {ReadonlyArray<{ from: string, to: string, tokens?: boolean, append?: string }>}
 */
export const PAGE_ASSETS = [
  { from: "desktop/web-v3/index.html", to: "index.html" },
  { from: "desktop/web-v3/manifest.webmanifest", to: "manifest.webmanifest" },
  { from: "desktop/web-v3/shell/shell.css", to: "shell.css" },
  { from: "desktop/web-v3/pdf-viewer/pdf.html", to: "pdf.html" },
  { from: "desktop/web-v3/pdf-viewer/viewer.css", to: "pdf-viewer.css" },
  // The 2.x page's look and icons (read, never edited).
  { from: "desktop/mobile/web.css", to: "web.css" },
  { from: "desktop/mobile/icon.svg", to: "icon.svg" },
  { from: "desktop/mobile/icon-180.png", to: "icon-180.png" },
  { from: "desktop/mobile/icon-192.png", to: "icon-192.png" },
  { from: "desktop/mobile/icon-512.png", to: "icon-512.png" },
  { from: "desktop/mobile/icon-maskable-512.png", to: "icon-maskable-512.png" },
  { from: "desktop/mobile/frame-host.html", to: "frame-host.html" },
  { from: "desktop/mobile/frame-host.js", to: "frame-host.js" },
  { from: "desktop/src/renderer/styles.css", to: "styles.css", tokens: true, append: "desktop/src/renderer/ModelPicker.css" },
  { from: "desktop/src/renderer/chat-frame/chat.html", to: "chat.html" },
  { from: "desktop/src/renderer/chat-frame/frame.css", to: "frame.css" },
  { from: "Web/src/chat.css", to: "chat.css", tokens: true },
];

/** The code that makes the page, beside its assets: a change to how files are copied or listed changes what ships. */
export const PAGE_BUILD_FILES = ["desktop/web-v3/build.mjs", "desktop/web-v3/page-assets.mjs", "desktop/fe-build-manifest.mjs", "desktop/fe-shell-manifest.mjs"];
