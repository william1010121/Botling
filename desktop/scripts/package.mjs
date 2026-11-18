// Builds Botling 2.0 (or Botling 3 with --v3) for distribution:
// `node scripts/package.mjs [--v3] [--mac|--win|--linux] [--dir]`
// (npm run dist:mac). Bundles out/ and mobile/dist/, then runs electron-builder with
// electron-builder.config.cjs (or electron-builder.v3.config.cjs when --v3 is set). It never publishes.
// Signing and notarizing happen only when the certificate variables name one (CSC_LINK, APPLE_API_KEY, ...);
// see the release workflow.
//
// Caches stay beside the checkout unless set: electron-builder's (ELECTRON_BUILDER_CACHE) and
// Electron's downloads (electron_config_cache) default to desktop/.cache/, never ~/Library/Caches.
// When the development work drive is mounted (BOTLING_DEV_WORK_DIR, else /Volumes/My-SSD/botling-work;
// core/app-swap.ts's devWorkRoot) they go to its cache/ instead; unmounted, beside the checkout as before.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveBuilderConfigPath(args = [], root = desktop) {
  const filename = args.includes("--v3") ? "electron-builder.v3.config.cjs" : "electron-builder.config.cjs";
  return join(root, filename);
}

/** A Botling 3 release build (BOTLING_RELEASE_BUILD=1, which the release workflow sets) must be told its version:
 * without BOTLING_V3_VERSION the v3 config stamps 3.0.0-beta.1, and one that differs from package.json would publish
 * a feed that no tag names. Throws; does nothing for 2.x or for a developer's local build. */
export function assertV3ReleaseVersion(args, env, packageVersion) {
  if (!args.includes("--v3") || env.BOTLING_RELEASE_BUILD !== "1") return;
  if (!/^3\.\d+\.\d+$/.test(packageVersion)) throw new Error(`A Botling 3 release needs a stable 3.x.y package version, got ${packageVersion}`);
  if (env.BOTLING_V3_VERSION !== packageVersion) {
    throw new Error(`A Botling 3 release build needs BOTLING_V3_VERSION=${packageVersion} (the package.json version); got ${env.BOTLING_V3_VERSION ?? "nothing"}, which would stamp the app with the config's default`);
  }
}

export async function runPackage(args = process.argv.slice(2)) {
  assertV3ReleaseVersion(args, process.env, JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version);
  const workDrive = (() => {
    const dir = process.env.BOTLING_DEV_WORK_DIR?.trim() || "/Volumes/My-SSD/botling-work";
    const volume = /^\/Volumes\/[^/]+/.exec(dir)?.[0];
    try {
      if (volume && statSync(volume).dev === statSync("/Volumes").dev) return null; // an empty mount point
      return dir.startsWith("/") && statSync(dir).isDirectory() ? dir : null;
    } catch { return null; }
  })();
  const caches = workDrive ? join(workDrive, "cache") : join(desktop, ".cache");
  process.env.ELECTRON_BUILDER_CACHE ||= join(caches, "electron-builder");
  process.env.electron_config_cache ||= join(caches, "electron");
  // Never sign with some certificate that happens to be in the keychain: only one named by CSC_LINK/CSC_NAME.
  if (!process.env.CSC_LINK && !process.env.CSC_NAME) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  for (const dir of [process.env.ELECTRON_BUILDER_CACHE, process.env.electron_config_cache]) mkdirSync(dir, { recursive: true });

  const built = spawnSync(process.execPath, [join(desktop, "build.mjs")], { cwd: desktop, stdio: "inherit" });
  if (built.status !== 0) process.exit(built.status ?? 1);

  // Build the browser client afresh; a failed mobile build must stop packaging too.
  const mobileBuilt = spawnSync(process.execPath, [join(desktop, "mobile/build.mjs")], { cwd: desktop, stdio: "inherit" });
  if (mobileBuilt.status !== 0) process.exit(mobileBuilt.status ?? 1);

  const { build, Platform } = await import("electron-builder");
  const platforms = [];
  if (args.includes("--mac")) platforms.push(Platform.MAC);
  if (args.includes("--win")) platforms.push(Platform.WINDOWS);
  if (args.includes("--linux")) platforms.push(Platform.LINUX);
  if (!platforms.length) platforms.push(Platform.current());
  const config = (await import(pathToFileURL(resolveBuilderConfigPath(args, desktop)).href)).default;
  // The config's targets (macOS: an arm64 zip and DMG), or with --dir only the unpacked app (for this machine's arch).
  const targets = new Map();
  for (const platform of platforms) {
    for (const [key, archs] of (args.includes("--dir") ? platform.createTarget("dir") : platform.createTarget())) targets.set(key, archs);
  }
  const files = await build({ targets, config, projectDir: desktop, publish: "never" });
  // electron-builder signs DMGs only with a certificate; keep the local container signed too.
  // No DMG blockmap is emitted (electron-updater uses the ZIP), so this cannot stale update metadata.
  if (process.platform === "darwin" && !process.env.CSC_LINK && !process.env.CSC_NAME) {
    for (const file of files.filter((file) => file.endsWith(".dmg"))) {
      const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", file], { stdio: "inherit" });
      if (signed.status !== 0) process.exit(signed.status ?? 1);
    }
  }
  for (const file of files) console.log(`built ${file}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPackage();
}
