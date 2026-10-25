// Real bundles/processes on disposable storage. Trust + transport are constructor dependencies of
// the production VerifiedInstaller, driven here by the test (no production key or runtime bypass).
// The candidate's receipt and rollback reopen run the actual packaged main/core/renderer.
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { VerifiedInstaller, recoverUpdates } from '../../src/main/update-install';
import { payload } from '../../scripts/release-manifest.mjs';
import { desktop, tempDir, until } from '../helpers';

const current = JSON.parse(readFileSync(join(desktop,'package.json'),'utf8')).version;
const app = process.env.BOTLING_PACKAGED_APP ?? join(desktop,'.cache/dist/mac-arm64/Botling 2.app');
const older = process.env.BOTLING_UPDATE_OLD_APP ?? join(desktop,'.cache/update-old/mac-arm64/Botling 2.app');
const zip = join(dirname(dirname(app)),`Botling-2-${current}-mac-arm64-unsigned-updates.zip`);
const evidence = join(desktop,'.cache/evidence/review');
test.skip(process.platform !== 'darwin','Real macOS transaction');

function alive(pid: number) { try { process.kill(pid,0);return true; } catch {return false;} }
function pids(bundle: string) {
 return execFileSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{
  const match=/^\s*(\d+)\s+(.*)$/.exec(line);return match && match[2]!.startsWith(bundle+'/Contents/') ? [Number(match[1])] : [];
 });
}
async function connect(port:number):Promise<Browser>{return until(async()=>{try{return await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:800});}catch{return null;}},{timeout:30000,what:'disposable app CDP'});}
async function pageOf(browser:Browser):Promise<Page>{
 const page=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url()==='app://botling/index.html'),{timeout:30000});
 await page.waitForSelector('.shell[data-ready="1"]',{timeout:30000});return page;
}
function post(page:Page,cmd:Record<string,unknown>):Promise<any>{return page.evaluate(cmd=>new Promise(resolve=>{
 const bridge=(window as any).botling,id='update-'+Math.random();const off=bridge.subscribe((m:any)=>{if(m.id===id){off();resolve(m);}});
 bridge.post({v:10,id,cmd});setTimeout(()=>{off();resolve(null);},5000);
}),cmd);}

test.beforeAll(()=>{for(const file of [app,older,zip])if(!existsSync(file))throw new Error(`Missing update fixture ${file}; build the development distribution and the older --dir fixture first.`);});

for(const mode of ['receipt','crash'] as const)test(`A3 real signed ZIP → explicit restart → ${mode==='receipt'?'real main receipt and commit':'crash rollback and open -n recovery'}`,async()=>{
 test.setTimeout(180000);
 const base=tempDir('pkg-update-'+mode),target=join(base,'Botling 2.app'),data=join(base,'data'),home=join(base,'home');
 const binary=join(target,'Contents/MacOS/Botling 2');mkdirSync(home);mkdirSync(join(data,'core'),{recursive:true});
 writeFileSync(join(data,'core/settings.json'),JSON.stringify({updateCheckEnabled:false}));
 writeFileSync(join(data,'core/review-schema'),'old-flushed');
 const plugin=join(data,'core/plugins/review');mkdirSync(join(plugin,'dist'),{recursive:true});
 writeFileSync(join(plugin,'package.json'),JSON.stringify({name:'review',version:'1.0.0',engines:{ccb:'^2.0.0'},ccb:{host:'dist/host.mjs',contributes:{commands:[{id:'review.ping',title:'Ping'}]}}}));
 writeFileSync(join(plugin,'dist/host.mjs'),'export function activate(ccb){ccb.commands.register("review.ping",()=>"real host after commit");}');
 execFileSync('/usr/bin/ditto',[older,target]);
 const reserve=socketServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
 const args=['--use-mock-keychain',`--remote-debugging-port=${port}`];
 const env={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:base,BOTLING_DATA_DIR:data,BOTLING_IMPORT_FROM:'',BOTLING_1X_DIR:'',BOTLING_CLAUDE_PATH:'/usr/bin/false',BOTLING_CODEX_PATH:'/usr/bin/false',CODEX_HOME:join(home,'codex'),CLAUDE_CONFIG_DIR:join(home,'claude'),BOTLING_LANGUAGES:'en-US'};
 // Helper inherits these synthetic paths. No CLI is run in either version.
 const old=spawn(binary,args,{env,stdio:'ignore'});
 let browser:Browser|null=null,helperPid=0,candidatePid=0,root='';
 const pair=generateKeyPairSync('ed25519');const publicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const hash=createHash('sha256');let size=0;for await(const bytes of createReadStream(zip)){hash.update(bytes);size+=bytes.length;}
 const fields={version:current,size,sha256:hash.digest('hex')};const manifest={...fields,signature:sign(null,payload(fields),pair.privateKey).toString('base64')};
 const server=createServer((req,res)=>{if(req.url?.endsWith('.manifest.json'))res.end(JSON.stringify(manifest));else createReadStream(zip).pipe(res);}).listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${(server.address() as any).port}/release.zip`;
 let installer:VerifiedInstaller|null=null;
 try{
  browser=await connect(port);let page=await pageOf(browser);
  const before=await post(page,{type:'updates.check',manual:false});expect(before.result.current).toBe('2.0.0-dev');
  installer=new VerifiedInstaller({current:before.result.current,appPath:target,dataDir:data,publicKey,platform:'darwin',arch:process.arch,fetch:url=>fetch(url,{signal:AbortSignal.timeout(120000)}),assetURL:()=>url,launchArgs:args});
  const release={version:current,name:'Throwaway signed transaction',url:`https://github.com/william1010121/Botling/releases/tag/v${current}`,asset:`Botling-2-${current}-mac-${process.arch}.zip`,publishedAt:null};
  await installer.stage(release);expect(installer.ready).toBe(current);expect(alive(old.pid!)).toBe(true);
  root=join(base,readdirSync(base).find(n=>n.startsWith('.botling-update-'))!);
  expect(existsSync(join(root,'previous.app'))).toBe(false);
  expect(existsSync(join(data,'update-pending.json'))).toBe(false);
  // The explicit transaction call alone starts the helper. Only then request normal main SIGTERM.
  await installer.restart(old.pid!);
  await until(()=>existsSync(join(root,'helper.pid')));helperPid=Number(readFileSync(join(root,'helper.pid'),'utf8'));
  expect(alive(old.pid!)).toBe(true);expect(existsSync(join(root,'previous.app'))).toBe(false);
  await browser.close();browser=null;old.kill('SIGTERM');await until(()=>old.exitCode!==null||old.signalCode!==null,{timeout:30000});expect(old.exitCode).toBe(0);
  await until(()=>existsSync(join(root,'new.pid')));candidatePid=Number(readFileSync(join(root,'new.pid'),'utf8'));
  if(mode==='crash'){
   expect(existsSync(join(root,'boot.ok'))).toBe(false);
   writeFileSync(join(data,'core/review-schema'),'candidate-incompatible');process.kill(candidatePid,'SIGKILL');
  }
  await until(()=>existsSync(join(root,'result')),{timeout:30000});const result=readFileSync(join(root,'result'),'utf8').trim();expect(result).toBe(mode==='receipt'?'booted':'failed:13');
  const token=JSON.parse(readFileSync(join(data,'update-pending.json'),'utf8')).token;
  if(mode==='receipt'){
   expect(readFileSync(join(root,'boot.ok'),'utf8')).toBe(token);await until(()=>existsSync(join(root,'activated.ok')),{timeout:30000});
   expect(readFileSync(join(root,'activated.ok'),'utf8')).toBe(token);
  }
  browser=await connect(port);page=await pageOf(browser);
  const after=await post(page,{type:'updates.check',manual:false});expect(after.result.current).toBe(mode==='receipt'?current:'2.0.0-dev');
  if(mode==='crash'){
   await expect(page.getByRole('alert',{name:'Update recovery'})).toContainText('failed:13');
   expect(readFileSync(join(data,'core/review-schema'),'utf8')).toBe('old-flushed');
  }
  await expect.poll(async()=> (await post(page,{type:'plugins.command',id:'review.ping'}))?.result?.result,{timeout:30000}).toBe('real host after commit');
  expect((await post(page,{type:'boot.commit'})).ok).toBe(false); // core-only, never renderer authority
  await until(()=>!alive(helperPid),{timeout:10000});
  await recoverUpdates(data,target);
  if(existsSync(root)){
   mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'cleanup-race-observation.json'),JSON.stringify({names:readdirSync(root),pending:existsSync(join(data,'update-pending.json')),metadata:Object.fromEntries(['result','owner.json','helper.pid','new.pid'].map(n=>[n,existsSync(join(root,n))?readFileSync(join(root,n),'utf8'):null]))},null,2));
  }
  mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'cleanup-diagnostics-'+mode+'.json'),JSON.stringify(readdirSync(join(data,'update-diagnostics')).map(n=>JSON.parse(readFileSync(join(data,'update-diagnostics',n),'utf8'))),null,2));
  expect(readdirSync(base).filter(n=>n.startsWith('.botling-update-'))).toEqual([]);expect(existsSync(join(data,'update-pending.json'))).toBe(false);
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',target]);
  const survivors=pids(target);expect(survivors.length).toBeGreaterThan(0);
  await browser.close();browser=null;
  for(const pid of survivors)try{process.kill(pid,'SIGTERM');}catch{}
  await until(()=>pids(target).length===0,{timeout:30000});
  mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,`packaged-update-${mode}.json`),JSON.stringify({mode,zip,manifest,publicKey,oldVersion:before.result.current,newVersion:after.result.current,explicitRestart:true,oldSIGTERMExit:old.exitCode,helperPid,candidatePid,result,realMainReceipt:mode==='receipt',realLaunchServicesRecovery:mode==='crash',dataRestored:mode==='crash',bundleSignatureValid:true,cleanup:true,remainingProcesses:pids(target),trustInjection:'VerifiedInstaller constructor in test driver; packaged trust remains null',forcedCrash:mode==='crash'?'SIGKILL before receipt':null},null,2)+'\n');
 }catch(error){
  mkdirSync(evidence,{recursive:true});
  const roots=readdirSync(base).filter(n=>n.startsWith('.botling-update-'));
  writeFileSync(join(evidence,'packaged-failure-'+mode+'.json'),JSON.stringify({error:String(error),pages:browser?.contexts().flatMap(c=>c.pages()).map(p=>p.url()),pids:pids(target),roots:roots.map(n=>({name:n,names:readdirSync(join(base,n))})),diagnostics:existsSync(join(data,'update-diagnostics'))?readdirSync(join(data,'update-diagnostics')).map(n=>JSON.parse(readFileSync(join(data,'update-diagnostics',n),'utf8'))):[]},null,2));
  throw error;
 }finally{
  await browser?.close().catch(()=>{});
  if(helperPid&&alive(helperPid))try{process.kill(helperPid,'SIGTERM');}catch{}
  for(const pid of pids(target))try{process.kill(pid,'SIGTERM');}catch{}
  await new Promise(resolve=>setTimeout(resolve,1500));
  for(const pid of [...pids(target),helperPid,candidatePid,old.pid!])if(pid&&alive(pid))try{process.kill(pid,'SIGKILL');}catch{}
  await installer?.discard();await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});
  rmSync(base,{recursive:true,force:true});
 }
});
