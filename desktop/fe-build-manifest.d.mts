export const FE_MANIFEST_FILE: string;
export const INPAGE_PLUGINS_DIR: string;
/** The manifest file's object. Named so a later card (M7-10b: `shell`) adds a member here, not to every signature. */
export interface FeBuildManifest {
  version: number;
  plugins: { name: string; codeHash: string }[];
}
export function folderHash(dir: string): string;
export function inpagePluginFolders(root: string): { name: string; folder: string }[];
export function feBuildManifest(root: string): FeBuildManifest;
export function feBuildManifestFile(root: string): Buffer;
