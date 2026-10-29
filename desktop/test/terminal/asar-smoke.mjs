// Targeted native resource-layout check; not an app package or install.
import { createPackageWithOptions, extractFile, statFile } from '@electron/asar';
import { mkdirSync, writeFileSync, readFileSync, accessSync, constants, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import { stageTerminalRuntime } from '../../scripts/terminal-runtime.mjs';
const require=createRequire(import.meta.url), root=resolve('.cache/terminal-asar');
rmSync(root,{recursive:true,force:true});mkdirSync(root,{recursive:true});
const source=join(root,'source');mkdirSync(join(source,'out/main'),{recursive:true});
stageTerminalRuntime(process.cwd(),join(source,'out/main'));
writeFileSync(join(source,'package.json'),JSON.stringify({name:'botling-terminal-native-smoke',main:'out/main/smoke.cjs'}));
writeFileSync(join(source,'out/main/smoke.cjs'),`
const {app}=require('electron');const assert=require('node:assert/strict');
process.on('uncaughtException',e=>{console.error(e);process.exit(1)});
app.setPath('userData',${JSON.stringify(join(root,'profile'))});
app.whenReady().then(()=>{
 const p=require('node-pty').spawn('/bin/sh',['-c',"printf 'ASAR_PTY_OK\\\\n'; stty size"],{cwd:${JSON.stringify(root)},env:{PATH:'/usr/bin:/bin',TERM:'xterm-256color'},cols:93,rows:27});
 let output='';p.onData(d=>output+=d);p.onExit(({exitCode})=>{assert.equal(exitCode,0);assert(output.includes('ASAR_PTY_OK'));assert(output.includes('27 93'));console.log(JSON.stringify({asar:true,output,electron:process.versions.electron,modules:process.versions.modules,napi:process.versions.napi}));app.exit(0)});
});
`);
// This asar version returns an ending WriteStream before its final flush completes.
// Never block the event loop with Electron startup until that stream has finished.
const archive = join(root,'app.asar');
const writer = await createPackageWithOptions(source,archive,{unpackDir:'out/main/node_modules/node-pty'});
await finished(writer);
const manifest = extractFile(archive,'package.json');
assert(manifest.equals(readFileSync(join(source,'package.json'))));
assert.equal(JSON.parse(manifest.toString('utf8')).main,'out/main/smoke.cjs');
for (const file of ['out/main/smoke.cjs','out/main/node_modules/node-pty/package.json']) {
  assert(extractFile(archive,file).equals(readFileSync(join(source,file))));
}
const helper='out/main/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper';
assert(statFile(archive,helper).unpacked);accessSync(join(archive+'.unpacked',helper),constants.X_OK);
// Launch a known-valid plain bootstrap. Failures inside the ASAR go to stderr, not a modal.
const bootstrap=join(root,'bootstrap.cjs');
writeFileSync(bootstrap,`process.on('uncaughtException',e=>{console.error(e);process.exit(1)});process.on('unhandledRejection',e=>{console.error(e);process.exit(1)});const {app}=require('electron');if(process.platform==='darwin')app.setActivationPolicy('prohibited');require('./app.asar/out/main/smoke.cjs');`);
console.log('ASAR preflight: exact manifest bytes, JSON.parse, entry bytes, native unpack and helper executable PASS');
if(process.argv.includes('--preflight-only')) process.exit(0);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[bootstrap],{env,encoding:'utf8',timeout:15000});
writeFileSync(join(root,'result.txt'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.message})+'\n'+result.stdout+result.stderr);
console.log({status:result.status,signal:result.signal,error:result.error?.message});
process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);
