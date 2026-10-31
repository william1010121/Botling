// Actual hot transaction + CoreSwapper + both generations of BotStore, synthetic profiles only.
import { expect, it as baseIt, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { BotStore } from '../../src/core/store/bot-store';
import { HotInstaller, applyHot, bundlePrints, planInstall } from '../../src/main/hot-install';
import { CoreSwapper } from '../../src/main/core-swap';
import { tempDir, desktop } from '../helpers';
// The historical planner is read from commit 65f0efa, which lives on a branch that is not in main's history
// (a CI checkout does not have it), so these cases run only where that commit is present.
const hasHistory=(()=>{try{execFileSync('git',['cat-file','-e','65f0efa^{commit}'],{cwd:desktop,stdio:'ignore'});return true;}catch{return false;}})();
const it=baseIt.skipIf(!hasHistory) as typeof baseIt;
let LegacyStore:typeof BotStore;
let oldPlanner: { bundlePrints: typeof bundlePrints; planInstall: typeof planInstall };
beforeAll(async()=>{
  if(!hasHistory)return;
  const contents=execFileSync('git',['show','9024ad5:desktop/src/core/store/bot-store.ts'],{cwd:desktop,encoding:'utf8'});
  const result=await build({stdin:{contents,resolveDir:join(desktop,'src/core/store'),loader:'ts'},bundle:true,platform:'node',format:'cjs',target:'node22',write:false});
  const module={exports:{} as any};new Function('require','module','exports',result.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);LegacyStore=module.exports.BotStore;
  const oldHot=execFileSync('git',['show','65f0efa:desktop/src/main/hot-install.ts'],{cwd:desktop,encoding:'utf8'});
  // Keep the historical planner's runtime part list historical too: today's list adds mobile.
  const oldPlan=execFileSync('git',['show','65f0efa:desktop/src/hot-install-plan.ts'],{cwd:desktop,encoding:'utf8'});
  const oldBundle=await build({stdin:{contents:oldHot,resolveDir:join(desktop,'src/main'),loader:'ts'},bundle:true,platform:'node',format:'cjs',target:'node22',write:false,
    plugins:[{name:'historical-install-plan',setup(plugin){plugin.onLoad({filter:/hot-install-plan\.ts$/},()=>({contents:oldPlan,loader:'ts'}));}}]});
  const hotModule={exports:{} as any};new Function('require','module','exports',oldBundle.outputFiles[0].text)(createRequire(import.meta.url),hotModule,hotModule.exports);oldPlanner=hotModule.exports;
});
const contract=(epoch=2)=>({version:1,epoch});
function core(root:string,name:string,metadata:unknown){
 const script=join(root,name,'core/main.cjs');fs.mkdirSync(dirname(script),{recursive:true});fs.writeFileSync(script,name);
 if(metadata!==undefined)fs.writeFileSync(join(dirname(script),'storage-contract.json'),JSON.stringify(metadata));return script;
}
it.each(['start','chat','shell'].flatMap(failure=>[false,true].map(compatible=>({failure,compatible}))))('rollback preserves history: $failure, compatible=$compatible',async({failure,compatible})=>{
 const root=tempDir('history-hot-gate'),profile=join(root,'profile');fs.mkdirSync(profile);
 const file=join(profile,'subagents.json'),original=[{id:'retained',result:'previous report'}];fs.writeFileSync(file,JSON.stringify(original));
 const oldScript=core(root,'old',contract(compatible?2:1)),candidate=core(root,'new',contract());let script=oldScript,candidateStarts=0;
 const swapper=new CoreSwapper({get script(){return script;},probe:async()=>null,hold(){},drain:async()=>({ok:true,entries:0,interrupted:[]}),undrain(){},stop:async()=>{},readHandover:()=>null,writeHandover(){},log(){},
 start:async target=>{script=target;if(target===candidate){candidateStarts++;const store=new BotStore(profile);const rows=store.loadList('subagents.json');rows.push({id:'candidate',result:'accepted report'});store.commitWorkerHistory(rows);await store.closeWorkerHistory();return failure==='start'?'candidate startup failed':null;}
 const old=compatible?new BotStore(profile):new LegacyStore(profile),rows=old.loadList('subagents.json');old.saveList('subagents.json',[...rows,{id:'after-rollback',result:'old writer resumed'}]);if(compatible)await (old as BotStore).closeWorkerHistory();return null;}});
 try{
 const result=await applyHot(['core','chat','shell'],{stage:async()=>({core:candidate,renderer:'new-renderer'}),install:async()=>{},restore:async()=>{},coreScript:()=>script,swapCore:target=>swapper.swap(target),useRenderer:()=> 'old-renderer',reloadChat:async()=>failure!=='chat',reloadShell:async()=>failure!=='shell',log(){}});
 expect(result.ok).toBe(false);
 if(compatible){expect(candidateStarts).toBe(1);expect(new BotStore(profile).loadList('subagents.json').map((r:any)=>r.id)).toEqual(['retained','candidate','after-rollback']);}
 else{expect(candidateStarts).toBe(0);expect(new LegacyStore(profile).loadList('subagents.json')).toEqual(original);expect(result.error).toMatch(/storage.*restart/i);}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it.each([undefined,{version:99,epoch:2},{version:1,epoch:2,unknown:true}])('unknown direct-swap metadata fails before probe: %j',async metadata=>{
 const root=tempDir('history-swap-unknown');let calls=0;
 const script=core(root,'old',contract()),candidate=core(root,'new',metadata);
 try{const swapper=new CoreSwapper({script,probe:async()=>{calls++;return null;},hold(){},drain:async()=>({ok:true,entries:0,interrupted:[]}),undrain(){},stop:async()=>{},start:async()=>null,readHandover:()=>null,writeHandover(){},log(){}});
 expect((await swapper.swap(candidate)).ok).toBe(false);expect(calls).toBe(0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
async function bundle(root:string,name:string,metadata:unknown,sidecar:unknown=metadata){
 const folder=join(root,name+'.app'),app=join(folder,'Contents/Resources/app');fs.mkdirSync(join(app,'out/core'),{recursive:true});
 fs.writeFileSync(join(folder,'Contents/Info.plist'),'<plist><dict><key>CFBundleIdentifier</key><string>test</string></dict></plist>');
 fs.writeFileSync(join(app,'package.json'),JSON.stringify({name:'test',botlingStorageContract:metadata}));fs.writeFileSync(join(app,'out/core/main.cjs'),name);
 if(sidecar!==undefined)fs.writeFileSync(join(app,'out/core/storage-contract.json'),JSON.stringify(sidecar));return bundlePrints(folder,fs);
}
it('planner fails closed for unknown/mismatched storage and retains compatible future hot updates',async()=>{
 const root=tempDir('history-plan-contract');try{
 const known=await bundle(root,'known',contract()),compatible=await bundle(root,'compatible',contract());
 expect(planInstall(known,compatible)).toEqual({mode:'hot',parts:['core']});
 const unknown=await bundle(root,'unknown',undefined),unknown2=await bundle(root,'unknown2',undefined);
 expect(planInstall(unknown,unknown2).mode).toBe('restart');
 // Pre-gate planners already hash package metadata as kernel: the initial installed array
 // reader cannot accidentally hot-apply this candidate just because it lacks our new gate.
 const legacyPrints=await oldPlanner.bundlePrints(join(root,'unknown.app'),fs);
 const candidatePrints=await oldPlanner.bundlePrints(join(root,'known.app'),fs);
 expect(oldPlanner.planInstall(legacyPrints,candidatePrints)).toEqual({mode:'restart',reasons:['kernel changed: package.json']});
 expect(planInstall(known,await bundle(root,'mismatch',contract(),contract(1))).mode).toBe('restart');
 expect(planInstall(known,await bundle(root,'legacy',contract(1))).mode).toBe('restart');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it('caches the running contract before disk install can replace its declaration',async()=>{
 const root=tempDir('history-running-contract'),script=core(root,'old',contract(1)),candidate=core(root,'new',contract());let starts=0;
 try{
 const swapper=new CoreSwapper({script,probe:async()=>null,hold(){},drain:async()=>({ok:true,entries:0,interrupted:[]}),undrain(){},stop:async()=>{},start:async()=>{starts++;return null;},readHandover:()=>null,writeHandover(){},log(){}});
 fs.writeFileSync(join(dirname(script),'storage-contract.json'),JSON.stringify(contract()));
 expect((await swapper.swap(candidate)).ok).toBe(false);expect(starts).toBe(0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it('unknown running storage cannot be inferred from a known candidate',async()=>{
 const root=tempDir('history-running-unknown'),script=core(root,'old',undefined),candidate=core(root,'new',contract());let calls=0;
 try{
 const swapper=new CoreSwapper({script,probe:async()=>{calls++;return null;},hold(){},drain:async()=>({ok:true,entries:0,interrupted:[]}),undrain(){},stop:async()=>{},start:async()=>null,readHandover:()=>null,writeHandover(){},log(){}});
 expect((await swapper.swap(candidate)).ok).toBe(false);expect(calls).toBe(0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
it('HotInstaller refuses unknown contracts before install or candidate execution',async()=>{
 const root=tempDir('history-installer-contract');let calls=0;
 try{
 await bundle(root,'old',undefined);await bundle(root,'new',undefined);
 const installer=new HotInstaller({target:join(root,'old.app'),dataDir:join(root,'data'),fs,run:async()=>{calls++;},notify:()=>{calls++;},ports:{coreScript:()=>{calls++;return 'unused';},swapCore:async()=>{calls++;throw Error('must not start');},useRenderer:()=>{calls++;return '';},reloadChat:async()=>{calls++;return true;},reloadShell:async()=>{calls++;return true;},log(){}}});
 const result=await installer.install({path:join(root,'new.app'),requester:'synthetic',note:'',from:'old',to:'new'});
 expect(result).toMatchObject({ok:false,plan:{mode:'restart'}});expect(calls).toBe(0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
