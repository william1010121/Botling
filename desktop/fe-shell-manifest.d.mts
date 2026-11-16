export interface TreeFile { path: string; id: string }
export interface FeTree {
  ids(paths: readonly string[]): TreeFile[];
  read(path: string): string;
  grep(root: string, needle: string): string[];
}
export interface ShellManifest { minFeVersion: string | null; hash: string }
export const WEB_V3_ENTRIES: readonly string[];
export const MIN_FE_VERSION_ROOT: string;
export const MIN_FE_VERSION_NAME: string;
export const PLUGIN_SOURCE_ROOTS: readonly string[];
export function isPluginSourcePath(path: string): boolean;
export function isNeutralPath(path: string): boolean;
export function shellInputs(repoRoot: string): string[];
export function shellAssetPaths(repoRoot: string): string[];
export function blobId(bytes: Uint8Array): string;
export function fsTree(repoRoot: string): FeTree;
export function gitTree(repoRoot: string, ref: string): FeTree;
export function shellHash(tree: FeTree, files: readonly string[]): string;
export function findMinFeVersion(tree: FeTree): string | null;
export function shellManifest(tree: FeTree, files: readonly string[]): ShellManifest;
export const SHELL_BASELINE_FILE: string;
export function shellBaselineText(minFeVersion: string): string;
export function parseShellBaseline(text: string): string | null;
