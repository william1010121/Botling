// On-demand fetch policy (protocol v1 §16, D51): free vs asks vs denied, deny list, real-path containment, limits.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { EntryRef } from "../../protocol";

const realpath = realpathSync.native ?? realpathSync;

export type BotId = string;

/**
 * Local FetchWhat definition until M5-05 (`protocol/fetch.ts`) merges; switch to the protocol import when M5-05 lands.
 */
export type FetchWhat =
  | { kind: "path"; path: string }
  | { kind: "artifact"; botId: BotId; path: string }
  | { kind: "blob"; id: string; entry: EntryRef }
  | { kind: "git"; path: string };

/** Fetch limits (§16). `PER_DAY_BYTES_PER_BOT` defaults to 2 GiB (v1 names the limit without a number). */
export const Limits = {
  PER_REQUEST_BYTES: 500 * 2 ** 20,
  PER_REQUEST_FILES: 20_000,
  PER_DAY_BYTES_PER_BOT: 2 * 2 ** 30,
} as const;

export type DenyPattern =
  | { kind: "segment"; name: string }
  | { kind: "subpath"; parts: readonly string[] }
  | { kind: "segment-glob"; pattern: RegExp; glob: string }
  | { kind: "file-glob"; pattern: RegExp; glob: string }
  | { kind: "marker-dir"; file: string };

/** Patterns checked against the real path (§16); `dataDir` is checked alongside this list. */
export const DENY: readonly DenyPattern[] = [
  { kind: "segment", name: ".ssh" },
  { kind: "segment", name: ".gnupg" },
  { kind: "segment", name: ".aws" },
  { kind: "segment", name: ".kube" },
  { kind: "segment", name: ".mozilla" },
  { kind: "subpath", parts: ["Library", "Keychains"] },
  { kind: "segment-glob", pattern: /\.keychain$/i, glob: "*.keychain" },
  { kind: "segment-glob", pattern: /\.keychain-db$/i, glob: "*.keychain-db" },
  { kind: "subpath", parts: ["Library", "Application Support", "Google", "Chrome"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Firefox"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Safari"] },
  { kind: "subpath", parts: [".config", "google-chrome"] },
  { kind: "subpath", parts: [".config", "chromium"] },
  { kind: "file-glob", pattern: /^id_rsa/i, glob: "id_rsa*" },
  { kind: "file-glob", pattern: /^id_ed25519/i, glob: "id_ed25519*" },
  { kind: "file-glob", pattern: /\.pem$/i, glob: "*.pem" },
  { kind: "file-glob", pattern: /\.key$/i, glob: "*.key" },
  { kind: "marker-dir", file: "server.db" },
];

export interface ClassifyInput {
  what: FetchWhat;
  botFolders: Map<BotId, string>;
  referenced(id: string, entry: EntryRef): boolean;
  dataDir: string;
}

export type ClassifyResult =
  | { kind: "free" | "ask"; prefix: string }
  | { kind: "denied"; reason: "deny-list" | "outside" };

function isSubpathOrEqual(realPrefix: string, realTarget: string): boolean {
  if (realPrefix.endsWith(sep)) return realTarget.startsWith(realPrefix);
  return realTarget === realPrefix || realTarget.startsWith(realPrefix + sep);
}

/** True only when `realpathSync.native` of both succeeds and the real path equals the real prefix or is beneath it on a separator boundary. */
export function realInside(prefix: string, targetPath: string): boolean {
  if (!prefix || !targetPath || prefix.includes("\0") || targetPath.includes("\0")) return false;
  let realPrefix: string;
  let realTarget: string;
  try {
    realPrefix = realpath(prefix);
    realTarget = realpath(targetPath);
  } catch {
    return false;
  }
  return isSubpathOrEqual(realPrefix, realTarget);
}

/** Resolves an absolute path to its canonical real path, failing closed on dangling symlinks or unresolvable `..`. */
function resolveCanonicalPath(targetPath: string): string | null {
  if (!targetPath || targetPath.includes("\0") || !isAbsolute(targetPath)) return null;
  try {
    return realpath(targetPath);
  } catch {
    // Do not resolve `..` or `.` lexically when the OS cannot canonicalize the path.
    const rawParts = targetPath.split(sep);
    if (rawParts.some((part) => part === ".." || part === ".")) return null;
    try {
      if (lstatSync(targetPath).isSymbolicLink()) return null;
    } catch {
      // Missing target: walk up to the nearest existing ancestor to resolve symlinked parents (e.g. /var -> /private/var).
    }
    const tail: string[] = [];
    let cur = targetPath;
    while (true) {
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
      try {
        lstatSync(cur);
      } catch {
        continue;
      }
      try {
        return join(realpath(cur), ...tail);
      } catch {
        return null;
      }
    }
  }
}

function hasSubpath(lowerSegments: readonly string[], parts: readonly string[]): boolean {
  if (parts.length === 0 || lowerSegments.length < parts.length) return false;
  const lowerParts = parts.map((p) => p.toLowerCase());
  for (let i = 0; i <= lowerSegments.length - lowerParts.length; i++) {
    let matched = true;
    for (let j = 0; j < lowerParts.length; j++) {
      if (lowerSegments[i + j] !== lowerParts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function hasMarkerFileInAncestors(realPath: string, markerFile: string): boolean {
  let dir = realPath;
  while (true) {
    if (existsSync(join(dir, markerFile))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function isDeniedRealPath(realPath: string, dataDir?: string): boolean {
  if (dataDir) {
    const realDataDir = resolveCanonicalPath(dataDir);
    if (realDataDir && isSubpathOrEqual(realDataDir, realPath)) return true;
  }
  const segments = realPath.split(sep).filter(Boolean);
  const lowerSegments = segments.map((s) => s.toLowerCase());
  const fileName = segments.length > 0 ? segments[segments.length - 1]! : "";

  for (const rule of DENY) {
    switch (rule.kind) {
      case "segment":
        if (lowerSegments.includes(rule.name.toLowerCase())) return true;
        break;
      case "subpath":
        if (hasSubpath(lowerSegments, rule.parts)) return true;
        break;
      case "segment-glob":
        if (segments.some((s) => rule.pattern.test(s))) return true;
        break;
      case "file-glob":
        if (fileName && rule.pattern.test(fileName)) return true;
        break;
      case "marker-dir":
        if (hasMarkerFileInAncestors(realPath, rule.file)) return true;
        break;
    }
  }
  return false;
}

/** Checks a path's real target against `DENY` and `dataDir`. */
export function isDeniedPath(targetPath: string, dataDir?: string): boolean {
  const realPath = resolveCanonicalPath(targetPath);
  if (!realPath) return false;
  return isDeniedRealPath(realPath, dataDir);
}

/** Classifies a fetch request at the source as free, ask, or denied (deny-list checked before everything else). */
export function classify(input: ClassifyInput): ClassifyResult {
  const { what, botFolders, referenced, dataDir } = input;

  if (what.kind === "blob") {
    return referenced(what.id, what.entry)
      ? { kind: "free", prefix: what.id }
      : { kind: "ask", prefix: what.id };
  }

  if (what.kind === "artifact") {
    if (what.path.includes("\0")) return { kind: "denied", reason: "outside" };
    const botFolder = botFolders.get(what.botId);
    if (!botFolder) {
      if (isAbsolute(what.path) && isDeniedPath(what.path, dataDir)) {
        return { kind: "denied", reason: "deny-list" };
      }
      return { kind: "denied", reason: "outside" };
    }
    const artifactsDir = join(botFolder, ".bot", "artifacts");
    // Concatenate without lexical normalization so symlinks before `..` are resolved by realpath first.
    const targetPath = what.path === ""
      ? artifactsDir
      : isAbsolute(what.path)
        ? what.path
        : `${artifactsDir}${sep}${what.path}`;
    const realTarget = resolveCanonicalPath(targetPath);
    if (!realTarget) return { kind: "denied", reason: "outside" };
    if (isDeniedRealPath(realTarget, dataDir)) return { kind: "denied", reason: "deny-list" };
    if (!realInside(artifactsDir, targetPath)) return { kind: "denied", reason: "outside" };
    return { kind: "free", prefix: realpath(artifactsDir) };
  }

  // kind: "path" | "git"
  if (!what.path || what.path.includes("\0") || !isAbsolute(what.path)) {
    return { kind: "denied", reason: "outside" };
  }
  const realTarget = resolveCanonicalPath(what.path);
  if (!realTarget) return { kind: "denied", reason: "outside" };
  if (isDeniedRealPath(realTarget, dataDir)) return { kind: "denied", reason: "deny-list" };

  for (const folder of botFolders.values()) {
    const artifactsDir = join(folder, ".bot", "artifacts");
    if (realInside(artifactsDir, realTarget)) {
      return { kind: "free", prefix: realpath(artifactsDir) };
    }
  }

  return { kind: "ask", prefix: realTarget };
}
