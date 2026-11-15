// The manifest written into the bundle at build time (M7-10a). The desktop window's CSP is `connect-src 'none'`
// (src/main/main.ts APP_CSP), so a `fetch` of fe-build-manifest.json cannot work there; the page reads the list its own
// bundle was built with instead. Both renderer builds (build-renderer.mjs, web-v3/build.mjs) pass the SAME bytes they write
// to fe-build-manifest.json (`feBuildManifestFile`) here, so the file and the bundle cannot name different lists.
// esbuild keeps a define only where code reads it: the loader's `embeddedFeManifest()` is the one reader.

/** The esbuild `define` entry for the manifest file's bytes (a Buffer or string). */
export const feManifestDefine = (file) => ({ __FE_MANIFEST__: JSON.stringify(Buffer.from(file).toString("utf8")) });
