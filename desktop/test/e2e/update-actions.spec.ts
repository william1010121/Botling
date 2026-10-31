import {backgroundPages,requireFocusOptIn} from "../hidden";
import {electronExecutable} from "../electron-runtime";
// Isolated renderer behavior: bundles only Updates.tsx, runs no core/CLIs or installed app.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { build } from "esbuild";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { desktop, tempDir } from "../helpers";

let app: ElectronApplication, page: Page;
test.beforeEach(async () => {
  const base = tempDir("update-actions");
  const entry = join(base, "ui.tsx");
  writeFileSync(entry, `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {UpdateActions} from '${join(desktop, "src/renderer/Updates.tsx")}';
window.calls=[]; window.failStage=false;
const initial = {current:'2.0.0',enabled:true,checkedAt:0,error:null,installError:null,readyVersion:null,newer:{version:'2.0.1',asset:'test.zip'}};
function App(){const [state,setState]=useState(initial); window.setTrustError=()=>setState({...initial,installError:'Update trust is not configured'});
const client={request:async(cmd)=>{window.calls.push(cmd.type);if(cmd.type==='updates.stage'){if(window.failStage)throw Error('Download failed');return {...initial,readyVersion:'2.0.1'}};return {restarting:true}}};
return <UpdateActions client={client} state={state} onChange={setState}/>}; createRoot(document.getElementById('root')).render(<App/>);`);
  await build({ entryPoints: [entry], outfile: join(base, "ui.js"), bundle: true, platform: "browser", jsx: "automatic", nodePaths: [join(desktop, "node_modules")] });
  writeFileSync(join(base, "index.html"), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="ui.js"></script>');
  writeFileSync(join(base, "main.cjs"), `const {app,BrowserWindow}=require('electron');if(process.env.BOTLING_HIDDEN==='1'&&process.platform==='darwin')app.setActivationPolicy('prohibited');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'profile'));app.setPath('crashDumps',path.join(__dirname,'crashes'));app.setPath('logs',path.join(__dirname,'logs'));app.commandLine.appendSwitch('use-mock-keychain');
app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(path.join(__dirname,'index.html'))}); app.on('window-all-closed',()=>app.quit());`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") env[key] = value;
  env.BOTLING_HIDDEN="1";requireFocusOptIn(env);
  app = await electron.launch({ executablePath:electronExecutable(), args: [join(base, "main.cjs")], env, cwd: desktop });
  page = await app.firstWindow();await backgroundPages(app,page);
  await expect(page.getByRole("button", { name: "Download update" })).toBeVisible();
});
test.afterEach(async () => { await app?.close(); });

test("staging and restart require separate explicit clicks", async () => {
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await page.getByRole("button", { name: "Download update" }).click();
  await expect(page.getByRole("button", { name: "Restart to update" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls)).toEqual(["updates.stage"]);
  await page.getByRole("button", { name: "Restart to update" }).click();
  expect(await page.evaluate(() => (window as any).calls)).toEqual(["updates.stage", "updates.restart"]);
});
test("failed verification never enables restart", async () => {
  await page.evaluate(() => { (window as any).failStage = true; });
  await page.getByRole("button", { name: "Download update" }).click();
  await expect(page.getByRole("status")).toHaveText("Download failed");
  await expect(page.getByRole("button", { name: "Restart to update" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).calls)).toEqual(["updates.stage"]);
});
test("unconfigured trust disables download and explains why", async () => {
  await page.evaluate(() => (window as any).setTrustError());
  await expect(page.getByRole("button", { name: "Download update" })).toBeDisabled();
  await expect(page.getByRole("status")).toHaveText("Update trust is not configured");
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
});
