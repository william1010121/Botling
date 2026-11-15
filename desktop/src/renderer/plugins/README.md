# In-page built-in plugins

One folder per plugin: `src/renderer/plugins/<folder>/index.ts` exporting `activate(api)` (it may return an undo function).
The folder name is lower case letters, digits and "-"; the plugin is named `botling.<folder>`.

The FE build lists every such folder in `fe-build-manifest.json` with the hash of the whole folder, and bundles it for the
shell's in-page loader (`src/renderer/shell/inpage-loader.ts`, `inpage-bundled.ts`). A new plugin adds its folder and
nothing else. This README keeps the folder present: esbuild's glob import of `plugins/*/index.ts` fails when the folder
is missing (it only warns when the folder holds no plugin).
