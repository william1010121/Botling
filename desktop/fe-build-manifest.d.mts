export const FE_MANIFEST_FILE: string;
export const INPAGE_PLUGINS_DIR: string;
/** The manifest file's object. `shell` (M7-10b) names the shell alone: MIN_FE_VERSION and the hash of the shell's files (fe-shell-manifest.mjs). */
export interface FeBuildManifest {
  version: number;
  shell: { minFeVersion: string | null; hash: string };
  plugins: { name: string; codeHash: string }[];
}
export function folderHash(dir: string): string;
export function inpagePluginFolders(root: string): { name: string; folder: string }[];
export interface FeBuildManifestOptions { requireMinFeVersion?: boolean }
export function feBuildManifest(root: string, repoRoot?: string, options?: FeBuildManifestOptions): FeBuildManifest;
export function feBuildManifestFile(root: string, repoRoot?: string, options?: FeBuildManifestOptions): Buffer;
