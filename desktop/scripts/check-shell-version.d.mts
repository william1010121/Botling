import type { FeTree, ShellManifest } from "../fe-shell-manifest.mjs";

export type ChangeKind = "plugin-only" | "other" | "none";
export interface ChangeResult { kind: ChangeKind; problems: string[] }
export interface RangeResult extends ChangeResult { commit: string; subject: string }
export type ShellHashFn = (tree: FeTree) => string;
export function classifyChange(paths: readonly string[]): ChangeKind;
export function shellAt(repo: string, ref: string, hash?: ShellHashFn): ShellManifest;
export function checkChange(repo: string, from: string, to: string, paths: readonly string[], options?: { hash?: ShellHashFn }): ChangeResult;
export function checkBaseline(repo: string, ref: string, hash?: ShellHashFn): string[];
export function checkRange(repo: string, base: string, head: string, options?: { whole?: boolean; hash?: ShellHashFn }): RangeResult[];
