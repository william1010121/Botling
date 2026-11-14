// Runs before the 2.x main module (src/main-v3/main.ts imports it first). Botling 3 M1 is a developer build beside 2.x:
// it must never open 2.x's data, and is not packaged yet (M6).
import { app } from "electron";
import { resolve } from "node:path";
import { v3DataDir } from "./paths";

const root = resolve(__dirname, "..", ".."); // desktop/

if (app.isPackaged) throw new Error("Botling 3 (main-v3) is a developer build in M1 and is not packaged.");
const chosen = v3DataDir(root, process.env);
if (!chosen.ok) throw new Error(chosen.error);
process.env.BOTLING_DATA_DIR = chosen.dataDir;
