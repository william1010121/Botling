// electron-builder's configuration for Botling 3, beside 2.x (M6-07a / M6-07c).
// Inherits everything from the 2.x config and overrides appId, productName, entry, version,
// artifact names, Linux executable name, output directory, and the v3 update channel.
// Electron fuses (including runAsNode: false) stay unchanged.
const { join } = require("node:path");
const base = require("./electron-builder.config.cjs");

if (typeof base.appId !== "string" || !base.appId.includes(".")) {
  throw new Error(`Expected dotted 2.x appId, got: ${String(base.appId)}`);
}

const env = process.env;
const appId = base.appId.replace(/\.[^.]+$/, ".Botling3");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  ...base,
  appId,
  productName: "Botling 3",
  artifactName: "Botling-3-${version}-${os}-${arch}.${ext}",
  nsis: {
    ...base.nsis,
    artifactName: "Botling-3-${version}-win-${arch}.${ext}",
  },
  linux: {
    ...base.linux,
    executableName: "botling3",
  },
  directories: {
    ...base.directories,
    output: join(env.BOTLING_DIST_DIR || join(__dirname, "dist"), "v3"),
  },
  extraMetadata: {
    ...base.extraMetadata,
    main: "out/main-v3/main.cjs",
    version: env.BOTLING_V3_VERSION || "3.0.0-beta.1",
    appId,
  },
  publish: Array.isArray(base.publish)
    ? base.publish.map((entry) => ({ ...entry, channel: "v3" }))
    : base.publish
      ? { ...base.publish, channel: "v3" }
      : base.publish,
};
