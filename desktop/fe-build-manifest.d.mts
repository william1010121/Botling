export const FE_MANIFEST_FILE: string;
export const INPAGE_PLUGINS_DIR: string;
export function folderHash(dir: string): string;
export function inpagePluginFolders(root: string): { name: string; folder: string }[];
export function feBuildManifest(root: string): { version: 1; plugins: { name: string; codeHash: string }[] };
export function feBuildManifestFile(root: string): Buffer;
