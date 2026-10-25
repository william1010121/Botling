// electron-builder's configuration for Botling 2.0 (Phase 5b). `npm run dist:mac` (scripts/package.mjs)
// builds out/ first, then this. Nothing here publishes: the package script always passes
// `publish: "never"`, and there is no publish provider.
//
// Signing is decided by the environment, so a machine without certificates still builds:
//   - macOS: CSC_LINK (+ CSC_KEY_PASSWORD) or CSC_NAME name a Developer ID Application certificate →
//     signed with it under the hardened runtime (build/entitlements.mac.plist), and notarized when
//     APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD +
//     APPLE_TEAM_ID, or APPLE_KEYCHAIN + APPLE_KEYCHAIN_PROFILE are set. Without a certificate: ad-hoc
//     ("-"), no hardened runtime (ad-hoc + hardened runtime fails library validation), no notarization.
//   - Windows: WIN_CSC_LINK / CSC_LINK (+ password) sign the installer and the app; otherwise unsigned.
//   - Linux: nothing is signed.
const { join } = require("node:path");

const env = process.env;
const macCertificate = Boolean(env.CSC_LINK || env.CSC_NAME);
const notarize = macCertificate && Boolean(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
  || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  || (env.APPLE_KEYCHAIN && env.APPLE_KEYCHAIN_PROFILE),
);
const assets = join(__dirname, "..", "Assets");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "io.github.william1010121.Botling2",
  productName: "Botling 2",
  copyright: "Copyright © 2026 william1010121",
  directories: { output: env.BOTLING_DIST_DIR || join(__dirname, "dist"), buildResources: join(__dirname, "build") },
  // Everything the app runs is bundled into out/ by build.mjs (main, preload, core, plugin host,
  // renderer, the web AIs' page readers); no node_modules, no source maps, no test fixtures.
  files: ["package.json", "out/**/*", "!out/**/*.map", "!node_modules/**/*"],
  asar: true,
  // Electron's zip comes from (and is kept in) this cache, never ~/Library/Caches (the package script sets it).
  electronDownload: { cache: env.ELECTRON_CACHE || env.electron_config_cache || join(__dirname, ".cache", "electron") },
  npmRebuild: false,
  nodeGypRebuild: false,
  buildDependenciesFromSource: false,
  extraMetadata: { main: "out/main/main.cjs" },
  // Electron's fuses, flipped in the binary before it is signed (https://www.electronjs.org/docs/latest/tutorial/fuses).
  electronFuses: {
    runAsNode: false, // the core and the plugin host are utility processes; Maintainer's check is `--check-plugin`
    enableCookieEncryption: true, // the web AIs' sign-ins are encrypted with the OS keychain's key
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, // macOS and Windows
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false, // the app serves its pages from app://, never file://
  },
  mac: {
    target: [{ target: "zip", arch: ["arm64"] }, { target: "dmg", arch: ["arm64"] }],
    category: "public.app-category.developer-tools",
    icon: join(assets, "AppIcon.icns"),
    darkModeSupport: true,
    minimumSystemVersion: "13.0",
    identity: macCertificate ? undefined : "-",
    hardenedRuntime: macCertificate,
    entitlements: macCertificate ? join(__dirname, "build", "entitlements.mac.plist") : undefined,
    entitlementsInherit: macCertificate ? join(__dirname, "build", "entitlements.mac.plist") : undefined,
    gatekeeperAssess: false,
    notarize,
    extendInfo: { NSHumanReadableCopyright: "Copyright © 2026 william1010121" },
  },
  dmg: {
    // package.mjs ad-hoc signs the container when there is no certificate.
    sign: macCertificate,
    // Self-updates authenticate the ZIP; there is no DMG update blockmap to publish.
    writeUpdateInfo: false,
    contents: [{ x: 150, y: 180, type: "file" }, { x: 450, y: 180, type: "link", path: "/Applications" }],
  },
  // Windows and Linux: configured, not built or tried here (see the README's Phase 5b gaps).
  win: {
    target: [{ target: "nsis", arch: ["x64", "arm64"] }],
    icon: join(assets, "AppIcon.png"),
  },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, artifactName: "Botling-2-${version}-win-${arch}.${ext}" },
  linux: {
    target: [{ target: "AppImage", arch: ["x64", "arm64"] }, { target: "deb", arch: ["x64", "arm64"] }],
    icon: join(assets, "AppIcon.png"),
    category: "Development",
    maintainer: "william1010121",
    synopsis: "Bots that work in your projects",
    executableName: "botling2",
  },
  artifactName: "Botling-2-${version}-${os}-${arch}.${ext}",
};
