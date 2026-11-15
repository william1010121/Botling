// The modules the FE build bundles for the in-page loader: every `src/renderer/plugins/<folder>/index.ts` (or index.tsx),
// named "botling.<folder>" as the manifest names it (desktop/fe-build-manifest.mjs). esbuild turns the template import into
// a map of the files the folder holds at build time (a glob import: no `eval`, no network, no shared list to edit). A
// card that adds an in-page plugin adds its folder and nothing here.
import type { InPageModule } from "./inpage-loader";

const FOLDER = /^botling\.([a-z0-9][a-z0-9-]*)$/;

export async function bundledInPagePlugin(name: string): Promise<InPageModule | undefined> {
  const folder = FOLDER.exec(name)?.[1];
  if (!folder) return undefined;
  // A folder the build did not bundle rejects here; the loader reports that as a failed load.
  return (await import(`../plugins/${folder}/index.ts`)) as InPageModule;
}
