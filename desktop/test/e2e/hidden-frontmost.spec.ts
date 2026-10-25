import {expect,test,type ElectronApplication} from '@playwright/test';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {launch} from './launch';
import {desktop,tempDir} from '../helpers';
import {electronExecutable} from '../electron-runtime';
import {frontmost} from '../frontmost';
import {FrontmostProof} from '../frontmost-proof';
const exec=promisify(execFile),pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test.skip(process.env.BOTLING_TEST_VERIFY_HIDDEN!=='1','Single explicitly authorized F0 safety verification');
test('F0 hidden recovery stays invisible and preserves the frontmost app',async()=>{
 test.setTimeout(25000);
 expect(process.env.BOTLING_TEST_ALLOW_FOCUS).not.toBe('1');
 const evidence=join(desktop,'.cache/evidence/run11');mkdirSync(evidence,{recursive:true});
 const executable=electronExecutable(),target=dirname(dirname(dirname(executable))),data=tempDir('f0-hidden'),token=randomUUID(),root=join(dirname(target),'.botling-update-f0-'+token),argument='--botling-update-data='+data;
 mkdirSync(root);writeFileSync(join(root,'owner.json'),JSON.stringify({target,dataDir:data,token}));writeFileSync(join(root,'result'),'failed:19');
 const proof=new FrontmostProof(750),startedAt=Date.now();
 let phase='before',stop=false,app:ElectronApplication|undefined,closing:Promise<void>|undefined,failure:Error|undefined,launchTask:ReturnType<typeof launch>|undefined;
 let runtime:any=null,journal:any[]=[];let abort!:()=>void;
 const failed=new Promise<void>(resolve=>{abort=resolve;});
 const matchingPids=async()=>{const {stdout}=await exec('/bin/ps',['-axww','-o','pid=,comm=,args='],{maxBuffer:4*1024*1024});return stdout.split('\n').flatMap(line=>{const match=/^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);return match?.[2]===executable&&match[3].split(/\s+/).includes(argument)?[Number(match[1])]:[];});};
 const closeOwn=()=>closing??=(async()=>{
  if(app)await Promise.race([app.close().catch(()=>{}),pause(5000)]);
  // Launch may still be connecting. Only exact private executable + unique synthetic-data arg.
  for(const pid of await matchingPids()){try{process.kill(pid,'SIGTERM');}catch{}}
  const end=Date.now()+3000;while((await matchingPids()).length&&Date.now()<end)await pause(50);
  for(const pid of await matchingPids()){try{process.kill(pid,'SIGKILL');}catch{}}
 })();
 const fail=(error:unknown)=>{if(!failure){failure=error instanceof Error?error:new Error(String(error));abort();void closeOwn().catch(()=>{});}};
 const check=()=>{if(failure)throw failure;};
 const guarded=async<T>(task:Promise<T>)=>Promise.race([task,failed.then(()=>{throw failure!;})]);
 let monitor:Promise<void>|undefined;
 try{
  const initial=await frontmost(),initialAt=Date.now();proof.sample(initial,'before',initialAt,initialAt);
  monitor=(async()=>{while(!stop&&!failure){const at=Date.now(),samplePhase=phase;
   try{proof.sample(await frontmost(),samplePhase,at,Date.now());}catch(error){fail(error);break;}
   if(app&&!closing){try{const snapshot=await app.evaluate(({BrowserWindow})=>({states:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),focused:w.isFocused()})),journal:(globalThis as any).__f0NativeJournal??[]}));journal=snapshot.journal;proof.window(Date.now(),snapshot.states,journal);}catch(error){if(!closing)fail(error);}}
   if(Date.now()-startedAt>15000){fail(new Error('Bounded F0 observation deadline exceeded'));break;}
   await pause(100);
  }})();
  await guarded(pause(300));check();phase='during';
  launchTask=launch({dataDir:data,waitForState:false,args:[argument],env:{BOTLING_HIDDEN:'1',BOTLING_TEST_TRACE:'0'},onLaunched:async own=>{
   app=own;if(failure){await own.close();throw failure;}
   runtime=await own.evaluate(({app,BrowserWindow})=>{
    const journal:any[]=[];(globalThis as any).__f0NativeJournal=journal;
    const watch=(window:InstanceType<typeof BrowserWindow>)=>{
     journal.push({at:Date.now(),event:'observed',id:window.id,visible:window.isVisible(),focused:window.isFocused()});
     const record=(event:string)=>journal.push({at:Date.now(),event,id:window.id,visible:window.isVisible(),focused:window.isFocused()});
     window.on('show',()=>record('show'));window.on('focus',()=>record('focus'));window.on('hide',()=>record('hide'));window.on('blur',()=>record('blur'));
    };for(const window of BrowserWindow.getAllWindows())watch(window);app.on('browser-window-created',(_event,window)=>watch(window));
    return{pid:process.pid,execPath:process.execPath,hidden:process.env.BOTLING_HIDDEN,agent:process.env.BOTLING_AGENT,userData:app.getPath('userData'),windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,visible:w.isVisible(),focused:w.isFocused()}))};
   });
  }});void launchTask.catch(()=>{});
  const run=await guarded(launchTask);check();
  await guarded(run.page.getByRole('heading',{name:'Update recovery required'}).waitFor({state:'attached',timeout:5000}));
  expect(runtime.hidden).toBe('1');expect(runtime.agent).toBe('fake');expect(runtime.execPath).toBe(executable);
  expect(runtime.userData.startsWith(join(desktop,'.cache/tmp')+'/')).toBe(true);
  await guarded(pause(900));check();
  expect(await run.app.evaluate(()=>(globalThis as any).__botlingCorePid())).toBeUndefined();
  phase='shutdown';await closeOwn();check();phase='after';const afterDeadline=Date.now()+1800;while(proof.samples.filter(sample=>sample.phase==='after').length<2&&Date.now()<afterDeadline){await guarded(pause(50));check();}
  stop=true;await monitor;check();proof.complete();expect(await matchingPids()).toEqual([]);
 }catch(error){fail(error);throw error;}
 finally{
  await closeOwn();stop=true;await monitor?.catch(()=>{});await launchTask?.catch(()=>{});
  const remaining=await matchingPids();
  writeFileSync(join(evidence,'f0-proof.json'),JSON.stringify({passed:!failure,sourceCommit:process.env.BOTLING_TEST_SOURCE_COMMIT,startedAt,endedAt:Date.now(),runtime,baseline:proof.baseline,samples:proof.samples,windows:proof.windows,journal,failure:failure?{message:failure.message,stack:failure.stack}:null,remainingPids:remaining,exitCode:app?.process().exitCode,signalCode:app?.process().signalCode,scope:'one hidden recovery window; normal/account/shot constructors static-only; no native key/focus/activation/LaunchServices actions',sampleBoundMs:750,requestedSamplePauseMs:100,JSONLAttempted:false},null,2)+'\n');
  rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});
 }
});
