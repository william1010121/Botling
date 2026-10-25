// Builds Botling 2.0 for distribution: `node scripts/package.mjs [--mac|--win|--linux] [--dir]`
// (npm run dist:mac). Bundles out/ (build.mjs), then runs electron-builder with
// electron-builder.config.cjs. It never publishes.
//
// Caches stay beside the checkout unless set: electron-builder's (ELECTRON_BUILDER_CACHE) and
// Electron's downloads (electron_config_cache) default to desktop/.cache/, never ~/Library/Caches.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
process.env.ELECTRON_BUILDER_CACHE ||= join(desktop, ".cache", "electron-builder");
process.env.electron_config_cache ||= join(desktop, ".cache", "electron");
// Never sign with some certificate that happens to be in the keychain: only one named by CSC_LINK/CSC_NAME.
if (!process.env.CSC_LINK && !process.env.CSC_NAME) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
for (const dir of [process.env.ELECTRON_BUILDER_CACHE, process.env.electron_config_cache]) mkdirSync(dir, { recursive: true });

const built = spawnSync(process.execPath, [join(desktop, "build.mjs")], { cwd: desktop, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);

const { build, Platform } = await import("electron-builder");
const platforms = [];
if (args.includes("--mac")) platforms.push(Platform.MAC);
if (args.includes("--win")) platforms.push(Platform.WINDOWS);
if (args.includes("--linux")) platforms.push(Platform.LINUX);
if (!platforms.length) platforms.push(Platform.current());
const config = (await import(join(desktop, "electron-builder.config.cjs"))).default;
// The config's targets (macOS: an arm64 zip and DMG), or with --dir only the unpacked app (for this machine's arch).
const targets = new Map();
for (const platform of platforms) {
  for (const [key, archs] of (args.includes("--dir") ? platform.createTarget("dir") : platform.createTarget())) targets.set(key, archs);
}
const files = await build({ targets, config, projectDir: desktop, publish: "never" });
// electron-builder signs DMGs only with a certificate; keep the local container signed too.
// No DMG blockmap is emitted (the custom updater uses the ZIP), so this cannot stale update metadata.
if (process.platform === "darwin" && !process.env.CSC_LINK && !process.env.CSC_NAME) {
  for (const file of files.filter((file) => file.endsWith(".dmg"))) {
    const signed = spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", file], { stdio: "inherit" });
    if (signed.status !== 0) process.exit(signed.status ?? 1);
  }
}
for (const file of files) console.log(`built ${file}`);
