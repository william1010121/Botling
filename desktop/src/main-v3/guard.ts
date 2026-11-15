// Runs before the 2.x main module (src/main-v3/main.ts imports it first).
// Botling 3 must never open 2.x's data folder (neither packaged nor dev).
import { app } from "electron";
import { resolve } from "node:path";
import { applyV3Guard } from "./paths";

const root = resolve(__dirname, "..", ".."); // desktop/

applyV3Guard({
  root,
  env: process.env,
  packaged: app.isPackaged ? { appData: app.getPath("appData") } : undefined,
});
// Marks this process as the Botling 3 window (not the environment, which children inherit): main.ts follows `v3`.
(globalThis as { __botlingV3Window?: boolean }).__botlingV3Window = true;
