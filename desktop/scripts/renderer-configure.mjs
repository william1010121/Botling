// Explicit persistent opt-in; no app installation, launch or restart is performed.
import { rendererAppData, readRendererConfiguration, writeRendererConfiguration } from "../renderer-config.mjs";
const args = process.argv.slice(2), actions = args.filter(arg => ["--enable", "--disable", "--status"].includes(arg));
const output = args.filter(arg => arg.startsWith("--outdir="));
if (actions.length > 1 || output.length > 1 || args.some(arg => !actions.includes(arg) && !output.includes(arg)) ||
    (output.length && actions[0] !== "--enable") || (actions[0] === "--enable" && !output.length))
  throw new Error("Usage: npm run renderer:configure -- [--status | --disable | --enable --outdir=/absolute/stable/renderer]");
const appData = rendererAppData();
if (actions[0] === "--enable") {
  const path = writeRendererConfiguration(appData, output[0].slice("--outdir=".length));
  console.log(`[renderer] enabled: ${path}`);
} else if (actions[0] === "--disable") {
  console.log(`[renderer] disabled: ${writeRendererConfiguration(appData, null)}`);
}
const config = readRendererConfiguration(appData);
if (config.warning) console.warn(config.warning);
console.log(`[renderer] configuration: ${config.path}`);
console.log(`[renderer] normal dev-trial launch: ${config.directory || "bundled renderer"}`);
if (actions[0] && actions[0] !== "--status") console.log("Applies at the next normal dev-trial launch; no app was started or restarted.");
