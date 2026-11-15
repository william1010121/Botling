// 2.x -> 3.x plugin library, plugin data, and plugins.json import (protocol v1 §14.4; M6-03a).
//
// Strictly read-only on the 2.x source folder:
// - copies plugins/<name>/ (text and binary files alike, skipping node_modules/, .git/, and files > 50 MB);
// - skips built-in library copies older than (or incompatible with) the built-in version shipped with botlingd;
// - copies each plugin's data folder (<source>/plugin-data/<name>/);
// - migrates plugins.json keeping disabled, installed, keys, and non-secret settings, dropping failures ({})
//   and stripping any setting key whose manifest declares `secret: true`;
// - NEVER reads or copies plugin-secrets.json (M6-06);
// - verifies canonical `folderHash` equality after copying each plugin and reports any mismatch.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeFileAtomic } from "../../core/durable/atomic";
import { folderHash } from "../../core/plugins/catalog";
import { libraryCopyWins } from "../../core/plugins/versions";

export const DEFAULT_MAX_PLUGIN_FILE_BYTES = 50 * 1024 * 1024;
const SKIPPED_DIR_NAMES = new Set(["node_modules", ".git"]);

export interface ImportPluginsOptions {
  /** Optional directory of built-in plugins shipped with botlingd (e.g. out/builtin-plugins). */
  builtInsDir?: string | null;
  /** Maximum file size in bytes to copy (defaults to 50 MB). */
  maxFileBytes?: number;
}

export interface ImportedPluginEntry {
  name: string;
  version: string;
  sourceHash: string;
  targetHash: string;
  hashMatches: boolean;
  filesCopied: number;
  replacesBuiltIn?: boolean;
}

export interface ImportPluginsResult {
  plugins: ImportedPluginEntry[];
  dataDirsCopied: string[];
  hashMismatches: Array<{ name: string; sourceHash: string; targetHash: string }>;
  skipped: string[];
  problems: string[];
  secretsStripped: Array<{ plugin: string; keys: string[] }>;
  pluginsJsonWritten: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function readFileReadOnly(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readJsonReadOnly(path: string): unknown {
  return JSON.parse(readFileReadOnly(path).toString("utf8"));
}

function readManifestIdentity(
  packageJsonPath: string,
  fallbackName: string,
): { name: string; version: string | null; secretKeys: Set<string>; problem?: string } {
  const secretKeys = new Set<string>();
  let raw: unknown;
  try {
    raw = readJsonReadOnly(packageJsonPath);
  } catch (error) {
    return { name: fallbackName, version: null, secretKeys, problem: errorText(error) };
  }
  if (!isPlainObject(raw)) {
    return { name: fallbackName, version: null, secretKeys, problem: "package.json is not an object" };
  }
  const name = typeof raw.name === "string" && raw.name ? raw.name : fallbackName;
  const version = typeof raw.version === "string" ? raw.version : null;

  for (const rootKey of ["ccb", "botling"] as const) {
    const field = raw[rootKey];
    if (!isPlainObject(field)) continue;
    const contributes = field.contributes;
    if (!isPlainObject(contributes)) continue;
    const settings = contributes.settings;
    if (!isPlainObject(settings)) continue;
    for (const [key, def] of Object.entries(settings)) {
      if (isPlainObject(def) && def.secret === true) {
        secretKeys.add(key);
      }
    }
  }

  return { name, version, secretKeys };
}

function collectBuiltInVersions(builtInsDir: string | null | undefined): {
  versions: Map<string, string>;
  secretKeysByPlugin: Map<string, Set<string>>;
} {
  const versions = new Map<string, string>();
  const secretKeysByPlugin = new Map<string, Set<string>>();
  if (!builtInsDir || !existsSync(builtInsDir)) {
    return { versions, secretKeysByPlugin };
  }
  let entries: string[];
  try {
    entries = readdirSync(builtInsDir).filter((name) => !name.startsWith(".")).sort();
  } catch {
    return { versions, secretKeysByPlugin };
  }
  for (const dirName of entries) {
    const dirPath = join(builtInsDir, dirName);
    const pkgPath = join(dirPath, "package.json");
    try {
      if (!statSync(dirPath).isDirectory() || !existsSync(pkgPath)) continue;
    } catch {
      continue;
    }
    const info = readManifestIdentity(pkgPath, dirName);
    if (info.version !== null) versions.set(info.name, info.version);
    if (info.secretKeys.size > 0) {
      secretKeysByPlugin.set(info.name, info.secretKeys);
      secretKeysByPlugin.set(dirName, info.secretKeys);
    }
  }
  return { versions, secretKeysByPlugin };
}

function copyTreeReadOnly(
  srcDir: string,
  dstDir: string,
  targetRoot: string,
  relLabelPrefix: string,
  maxFileBytes: number,
  skipped: string[],
  problems: string[],
): number {
  let filesCopied = 0;
  let realSrcRoot: string;
  try {
    realSrcRoot = realpathSync(srcDir);
  } catch (error) {
    problems.push(`${relLabelPrefix}: ${errorText(error)}`);
    return 0;
  }

  const walk = (currentSrc: string, currentDst: string, relBase: string) => {
    let entries;
    try {
      entries = readdirSync(currentSrc, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      problems.push(`${relBase}: ${errorText(error)}`);
      return;
    }

    mkdirSync(currentDst, { recursive: true });

    for (const entry of entries) {
      const srcPath = join(currentSrc, entry.name);
      const dstPath = join(currentDst, entry.name);
      const relLabel = `${relBase}/${entry.name}`;

      if (SKIPPED_DIR_NAMES.has(entry.name)) {
        let isDir = entry.isDirectory();
        if (!isDir && entry.isSymbolicLink()) {
          try {
            isDir = statSync(srcPath).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (isDir) {
          skipped.push(`${relLabel}/ (excluded directory)`);
          continue;
        }
      }

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      let statTarget = srcPath;

      if (entry.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = realpathSync(srcPath);
        } catch {
          skipped.push(`${relLabel}: unreadable symbolic link`);
          continue;
        }
        if (!isInside(realTarget, realSrcRoot)) {
          skipped.push(`${relLabel}: symbolic link points outside folder`);
          continue;
        }
        let targetStat;
        try {
          targetStat = statSync(realTarget);
        } catch {
          skipped.push(`${relLabel}: unreadable symbolic link target`);
          continue;
        }
        if (targetStat.isDirectory()) {
          skipped.push(`${relLabel}: symbolic link to directory`);
          continue;
        }
        isFile = targetStat.isFile();
        isDir = false;
        statTarget = realTarget;
      }

      if (isDir) {
        walk(srcPath, dstPath, relLabel);
        continue;
      }

      if (!isFile) continue;

      let st;
      try {
        st = statSync(statTarget);
      } catch (error) {
        problems.push(`${relLabel}: ${errorText(error)}`);
        continue;
      }

      if (st.size > maxFileBytes) {
        const limitMb = Math.round((maxFileBytes / (1024 * 1024)) * 100) / 100;
        skipped.push(`${relLabel}: larger than ${limitMb} MB (${st.size} bytes)`);
        continue;
      }

      if (!isInside(resolve(dstPath), targetRoot)) {
        throw new Error(`Refusing to write outside target directory: ${dstPath}`);
      }

      let data: Buffer;
      try {
        data = readFileReadOnly(statTarget);
      } catch (error) {
        problems.push(`${relLabel}: ${errorText(error)}`);
        continue;
      }

      mkdirSync(dirname(dstPath), { recursive: true });
      writeFileSync(dstPath, data, { mode: st.mode & 0o111 ? 0o755 : 0o644 });
      filesCopied++;
    }
  };

  walk(srcDir, dstDir, relLabelPrefix);
  return filesCopied;
}

function addSecretKeys(
  target: Map<string, Set<string>>,
  pluginName: string,
  keys: Set<string>,
): void {
  if (keys.size === 0) return;
  let existing = target.get(pluginName);
  if (!existing) {
    existing = new Set<string>();
    target.set(pluginName, existing);
  }
  for (const key of keys) existing.add(key);
}

/**
 * Copies the 2.x plugin library (`plugins/<name>/`), plugin data folders (`plugin-data/<name>/`),
 * and sanitized `plugins.json` into botlingd's data directory. Strictly read-only on `sourceDir`
 * and never reads or copies `plugin-secrets.json`.
 */
export function importPlugins(
  sourceDir: string,
  targetDir: string,
  options: ImportPluginsOptions = {},
): ImportPluginsResult {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (isInside(target, source) || isInside(source, target)) {
    throw new Error("The import's source and target must be separate folders.");
  }

  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_PLUGIN_FILE_BYTES;
  const plugins: ImportedPluginEntry[] = [];
  const dataDirsCopied: string[] = [];
  const hashMismatches: Array<{ name: string; sourceHash: string; targetHash: string }> = [];
  const skipped: string[] = [];
  const problems: string[] = [];
  const secretsStripped: Array<{ plugin: string; keys: string[] }> = [];

  const { versions: builtInVersions, secretKeysByPlugin } = collectBuiltInVersions(options.builtInsDir);

  // 1. Copy plugins/<name>/
  const srcPluginsRoot = join(source, "plugins");
  if (existsSync(srcPluginsRoot)) {
    let isDir = false;
    try {
      isDir = statSync(srcPluginsRoot).isDirectory();
    } catch (error) {
      problems.push(`plugins/: ${errorText(error)}`);
    }

    if (isDir) {
      let names: string[] = [];
      try {
        names = readdirSync(srcPluginsRoot).filter((name) => !name.startsWith(".")).sort();
      } catch (error) {
        problems.push(`plugins/: ${errorText(error)}`);
      }

      for (const dirName of names) {
        const srcPluginDir = join(srcPluginsRoot, dirName);
        const pkgPath = join(srcPluginDir, "package.json");
        try {
          if (!statSync(srcPluginDir).isDirectory() || !existsSync(pkgPath)) continue;
        } catch {
          continue;
        }

        const identity = readManifestIdentity(pkgPath, dirName);
        if (identity.problem) {
          problems.push(`plugins/${dirName}/package.json: ${identity.problem}`);
        }
        addSecretKeys(secretKeysByPlugin, identity.name, identity.secretKeys);
        addSecretKeys(secretKeysByPlugin, dirName, identity.secretKeys);

        let replacesBuiltIn = false;
        const builtInVersion = builtInVersions.get(identity.name);
        if (builtInVersion !== undefined) {
          if (identity.version === null || !libraryCopyWins(identity.version, builtInVersion)) {
            skipped.push(
              `plugins/${dirName}: built-in ${identity.name} (${builtInVersion}) supersedes library copy (${identity.version ?? "unknown"})`,
            );
            continue;
          }
          replacesBuiltIn = true;
        }

        const dstPluginDir = join(target, "plugins", dirName);
        const filesCopied = copyTreeReadOnly(
          srcPluginDir,
          dstPluginDir,
          target,
          `plugins/${dirName}`,
          maxFileBytes,
          skipped,
          problems,
        );

        let sourceHash = "";
        let targetHash = "";
        let hashMatches = false;
        try {
          sourceHash = folderHash(srcPluginDir);
          targetHash = folderHash(dstPluginDir);
          hashMatches = sourceHash === targetHash;
        } catch (error) {
          problems.push(`plugins/${dirName}: folderHash failed (${errorText(error)})`);
        }

        if (!hashMatches) {
          hashMismatches.push({ name: identity.name, sourceHash, targetHash });
        }

        plugins.push({
          name: identity.name,
          version: identity.version ?? "0.0.0",
          sourceHash,
          targetHash,
          hashMatches,
          filesCopied,
          ...(replacesBuiltIn ? { replacesBuiltIn: true } : {}),
        });
      }
    }
  }

  // 2. Copy plugin-data/<name>/
  const srcDataRoot = join(source, "plugin-data");
  if (existsSync(srcDataRoot)) {
    let isDir = false;
    try {
      isDir = statSync(srcDataRoot).isDirectory();
    } catch (error) {
      problems.push(`plugin-data/: ${errorText(error)}`);
    }

    if (isDir) {
      let names: string[] = [];
      try {
        names = readdirSync(srcDataRoot).filter((name) => !name.startsWith(".")).sort();
      } catch (error) {
        problems.push(`plugin-data/: ${errorText(error)}`);
      }

      for (const name of names) {
        const srcPluginData = join(srcDataRoot, name);
        try {
          if (!statSync(srcPluginData).isDirectory()) continue;
        } catch {
          continue;
        }
        const dstPluginData = join(target, "plugin-data", name);
        copyTreeReadOnly(
          srcPluginData,
          dstPluginData,
          target,
          `plugin-data/${name}`,
          maxFileBytes,
          skipped,
          problems,
        );
        dataDirsCopied.push(name);
      }
    }
  }

  // 3. Migrate plugins.json (drop failures, keep disabled/installed/keys/non-secret settings; never read plugin-secrets.json)
  let pluginsJsonWritten = false;
  const srcPluginsJson = join(source, "plugins.json");
  if (existsSync(srcPluginsJson)) {
    try {
      const raw = readJsonReadOnly(srcPluginsJson);
      if (!isPlainObject(raw)) {
        problems.push("plugins.json: not an object");
      } else {
        const disabled = Array.isArray(raw.disabled)
          ? raw.disabled.filter((item): item is string => typeof item === "string")
          : [];

        const installed: Record<string, string> = {};
        if (isPlainObject(raw.installed)) {
          for (const [k, v] of Object.entries(raw.installed)) {
            if (typeof v === "string") installed[k] = v;
          }
        }

        const settings: Record<string, Record<string, unknown>> = {};
        if (isPlainObject(raw.settings)) {
          for (const [pluginName, rawValues] of Object.entries(raw.settings)) {
            if (!isPlainObject(rawValues)) continue;
            const secretKeys = secretKeysByPlugin.get(pluginName) ?? new Set<string>();
            const keptValues: Record<string, unknown> = {};
            const strippedKeys: string[] = [];
            for (const [k, v] of Object.entries(rawValues)) {
              if (secretKeys.has(k)) {
                strippedKeys.push(k);
              } else {
                keptValues[k] = v;
              }
            }
            if (strippedKeys.length > 0) {
              secretsStripped.push({ plugin: pluginName, keys: strippedKeys });
            }
            settings[pluginName] = keptValues;
          }
        }

        let keys: Record<string, Record<string, string | null>> | undefined;
        if (isPlainObject(raw.keys)) {
          keys = {};
          for (const [pluginName, rawBindings] of Object.entries(raw.keys)) {
            if (!isPlainObject(rawBindings)) continue;
            const keptBindings: Record<string, string | null> = {};
            for (const [cmd, key] of Object.entries(rawBindings)) {
              if (typeof key === "string" || key === null) {
                keptBindings[cmd] = key;
              }
            }
            keys[pluginName] = keptBindings;
          }
        }

        const migrated: Record<string, unknown> = {
          disabled,
          settings,
          failures: {},
          installed,
          ...(keys !== undefined ? { keys } : {}),
        };

        mkdirSync(target, { recursive: true });
        writeFileAtomic(join(target, "plugins.json"), `${JSON.stringify(migrated, null, 2)}\n`);
        pluginsJsonWritten = true;
      }
    } catch (error) {
      problems.push(`plugins.json: ${errorText(error)}`);
    }
  }

  return {
    plugins,
    dataDirsCopied,
    hashMismatches,
    skipped,
    problems,
    secretsStripped,
    pluginsJsonWritten,
  };
}
