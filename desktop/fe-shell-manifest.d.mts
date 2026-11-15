export interface TreeFile { path: string; id: string }
export interface FeTree {
  files(roots: readonly string[]): TreeFile[];
  read(path: string): string;
  grep(root: string, needle: string): string[];
}
export interface ShellManifest { minFeVersion: string | null; codeHash: string }
export const SHELL_ROOTS: readonly string[];
export const MIN_FE_VERSION_ROOT: string;
export const MIN_FE_VERSION_NAME: string;
export const PLUGIN_SOURCE_ROOTS: readonly string[];
export function isPluginSourcePath(path: string): boolean;
export function isNeutralPath(path: string): boolean;
export function isShellPath(path: string, roots?: readonly string[]): boolean;
export function blobId(bytes: Uint8Array): string;
export function fsTree(repoRoot: string): FeTree;
export function gitTree(repoRoot: string, ref: string): FeTree;
export function shellHash(tree: FeTree, roots?: readonly string[], accept?: (path: string, roots: readonly string[]) => boolean): string;
export function findMinFeVersion(tree: FeTree): string | null;
export function shellManifest(tree: FeTree, roots?: readonly string[]): ShellManifest;
