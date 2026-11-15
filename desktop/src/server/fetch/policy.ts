// On-demand fetch policy (protocol v1 §16, D51): free vs asks vs denied, deny list, real-path containment, limits.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type { EntryRef } from "../../protocol";
import type { FetchWhat } from "../../protocol/fetch";

export type { FetchWhat };

const realpath = realpathSync.native ?? realpathSync;

export type BotId = string;

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
  { kind: "segment", name: ".docker" },
  { kind: "segment", name: ".netrc" },
  { kind: "subpath", parts: ["Library", "Keychains"] },
  { kind: "segment-glob", pattern: /\.keychain$/i, glob: "*.keychain" },
  { kind: "segment-glob", pattern: /\.keychain-db$/i, glob: "*.keychain-db" },
  { kind: "subpath", parts: ["Library", "Application Support", "Google", "Chrome"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Google", "Chrome Beta"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Google", "Chrome Canary"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Google", "Chrome Dev"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Chromium"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Firefox"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Safari"] },
  { kind: "subpath", parts: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"] },
  { kind: "subpath", parts: ["Library", "Application Support", "BraveSoftware", "Brave-Browser-Beta"] },
  { kind: "subpath", parts: ["Library", "Application Support", "BraveSoftware", "Brave-Browser-Nightly"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Microsoft Edge"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Microsoft Edge Beta"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Microsoft Edge Dev"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Microsoft Edge Canary"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Arc"] },
  { kind: "subpath", parts: ["Library", "Application Support", "Vivaldi"] },
  { kind: "subpath", parts: [".config", "google-chrome"] },
  { kind: "subpath", parts: [".config", "google-chrome-beta"] },
  { kind: "subpath", parts: [".config", "google-chrome-unstable"] },
  { kind: "subpath", parts: [".config", "chromium"] },
  { kind: "subpath", parts: [".config", "BraveSoftware", "Brave-Browser"] },
  { kind: "subpath", parts: [".config", "BraveSoftware", "Brave-Browser-Beta"] },
  { kind: "subpath", parts: [".config", "BraveSoftware", "Brave-Browser-Nightly"] },
  { kind: "subpath", parts: [".config", "microsoft-edge"] },
  { kind: "subpath", parts: [".config", "microsoft-edge-beta"] },
  { kind: "subpath", parts: [".config", "microsoft-edge-dev"] },
  { kind: "subpath", parts: [".config", "vivaldi"] },
  { kind: "subpath", parts: [".config", "gcloud"] },
  { kind: "subpath", parts: [".config", "gh"] },
  { kind: "file-glob", pattern: /^\.env$/i, glob: ".env" },
  { kind: "file-glob", pattern: /^\.env\./i, glob: ".env.*" },
  { kind: "file-glob", pattern: /^\.git-credentials$/i, glob: ".git-credentials" },
  { kind: "file-glob", pattern: /^\.npmrc$/i, glob: ".npmrc" },
  { kind: "file-glob", pattern: /^\.pypirc$/i, glob: ".pypirc" },
  { kind: "file-glob", pattern: /^id_rsa/i, glob: "id_rsa*" },
  { kind: "file-glob", pattern: /^id_ed25519/i, glob: "id_ed25519*" },
  { kind: "file-glob", pattern: /^id_ecdsa/i, glob: "id_ecdsa*" },
  { kind: "file-glob", pattern: /^id_dsa/i, glob: "id_dsa*" },
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

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

function assertAbsoluteDataDir(dataDir: string): void {
  if (!isAbsolute(dataDir)) {
    throw new Error(`dataDir must be an absolute path: ${JSON.stringify(dataDir)}`);
  }
}

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

/** Resolves an absolute path to its canonical real path, using the walk-up fallback only for ENOENT. */
function resolveCanonicalPath(targetPath: string): string | null {
  if (!targetPath || targetPath.includes("\0") || !isAbsolute(targetPath)) return null;
  try {
    return realpath(targetPath);
  } catch (err) {
    // Use the walk-up fallback only for ENOENT; EACCES/EPERM/ENOTDIR/etc. must fail closed.
    if (!isErrnoCode(err, "ENOENT")) return null;
    // Do not resolve `..` or `.` lexically when the OS cannot canonicalize the path.
    const rawParts = targetPath.split(sep);
    if (rawParts.some((part) => part === ".." || part === ".")) return null;
    try {
      lstatSync(targetPath);
      return null;
    } catch (lstatErr) {
      if (!isErrnoCode(lstatErr, "ENOENT")) return null;
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
      } catch (curErr) {
        if (isErrnoCode(curErr, "ENOENT")) continue;
        return null;
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

function isDeniedRealPath(realPath: string, dataDir: string): boolean {
  assertAbsoluteDataDir(dataDir);
  let realDataDir: string;
  try {
    realDataDir = realpath(dataDir);
  } catch {
    return true;
  }
  if (isSubpathOrEqual(realDataDir, realPath)) return true;

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

/** Checks a path's real target against `DENY` and `dataDir` (fails closed on resolution failure). */
export function isDeniedPath(targetPath: string, dataDir: string): boolean {
  assertAbsoluteDataDir(dataDir);
  const realPath = resolveCanonicalPath(targetPath);
  if (!realPath) return true;
  return isDeniedRealPath(realPath, dataDir);
}

/** Classifies a fetch request at the source as free, ask, or denied (deny-list checked before everything else). */
export function classify(input: ClassifyInput): ClassifyResult {
  const { what, botFolders, referenced, dataDir } = input;
  assertAbsoluteDataDir(dataDir);

  if (what.kind === "blob") {
    return referenced(what.id, what.entry)
      ? { kind: "free", prefix: what.id }
      : { kind: "ask", prefix: what.id };
  }

  if (what.kind === "artifact") {
    if (what.path.includes("\0")) return { kind: "denied", reason: "outside" };
    const botFolder = botFolders.get(what.botId);
    if (!botFolder) {
      if (isAbsolute(what.path)) {
        const realTarget = resolveCanonicalPath(what.path);
        if (realTarget && isDeniedRealPath(realTarget, dataDir)) {
          return { kind: "denied", reason: "deny-list" };
        }
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
    let realTarget: string;
    try {
      realTarget = realpath(targetPath);
    } catch {
      return { kind: "denied", reason: "outside" };
    }
    if (isDeniedRealPath(realTarget, dataDir)) return { kind: "denied", reason: "deny-list" };

    let realBotFolder: string;
    let realArtifactsDir: string;
    try {
      realBotFolder = realpath(botFolder);
      realArtifactsDir = realpath(artifactsDir);
    } catch {
      return { kind: "denied", reason: "outside" };
    }
    if (!isSubpathOrEqual(realArtifactsDir, realTarget)) {
      return { kind: "denied", reason: "outside" };
    }
    // Require exact <realBotFolder>/.bot/artifacts layout so symlinks on .bot or artifacts cannot widen `free`.
    if (realArtifactsDir !== join(realBotFolder, ".bot", "artifacts")) {
      return { kind: "ask", prefix: realTarget };
    }
    return { kind: "free", prefix: realArtifactsDir };
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
    let realBotFolder: string;
    let realArtifactsDir: string;
    try {
      realBotFolder = realpath(folder);
      realArtifactsDir = realpath(artifactsDir);
    } catch {
      continue;
    }
    if (
      realArtifactsDir === join(realBotFolder, ".bot", "artifacts") &&
      isSubpathOrEqual(realArtifactsDir, realTarget)
    ) {
      return { kind: "free", prefix: realArtifactsDir };
    }
  }

  return { kind: "ask", prefix: realTarget };
}
