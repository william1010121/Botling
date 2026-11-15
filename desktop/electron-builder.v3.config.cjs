// electron-builder's configuration for Botling 3, beside 2.x (M6-07a).
// Inherits everything from the 2.x config and overrides only appId, productName, entry, version,
// output directory, and the v3 update channel. Electron fuses (including runAsNode: false) stay unchanged.
const { join } = require("node:path");
const base = require("./electron-builder.config.cjs");

if (typeof base.appId !== "string" || !base.appId.includes(".")) {
  throw new Error(`Expected dotted 2.x appId, got: ${String(base.appId)}`);
}

const env = process.env;

/** @type {import("electron-builder").Configuration} */
module.exports = {
  ...base,
  appId: base.appId.replace(/\.[^.]+$/, ".Botling3"),
  productName: "Botling 3",
  directories: {
    ...base.directories,
    output: join(env.BOTLING_DIST_DIR || join(__dirname, "dist"), "v3"),
  },
  extraMetadata: {
    ...base.extraMetadata,
    main: "out/main-v3/main.cjs",
    version: env.BOTLING_V3_VERSION || "3.0.0-beta.1",
  },
  publish: Array.isArray(base.publish)
    ? base.publish.map((entry) => ({ ...entry, channel: "v3" }))
    : base.publish
      ? { ...base.publish, channel: "v3" }
      : base.publish,
};
