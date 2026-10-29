import {afterAll,beforeAll,afterEach,expect,it,vi} from 'vitest';
// This file covers the local-tools-only bridge; keep the worker gate closed here.
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>false,agyMixedRuntimeEnabled:()=>false,agyPairAllowed:()=>false}));
import {mkdtempSync,mkdirSync,readFileSync,existsSync,symlinkSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {AgyMcpBridge,verifyAgyFileHelper} from '../../src/core/agent/agy-mcp';
// Exact approved macOS arm64 Botling file helper, built from agy-file-helper.c with
// scripts/build-agy-file-helper.mjs (Apple clang 21.0.0). Gzip preserves all signed
// Mach-O bytes; the production verifier pins SHA256
// 1e6feb57e33dfa1e5ffed2a7a359e6cd15c0df3272293e2ed63ec7af2ffc3403.
// Inline because this test must run from a clean checkout without a developer cache,
// compiler-dependent output, downloads, an ACP server, or a live Google profile.
const helperBytes = gunzipSync(Buffer.from(
 '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' +
 'aXf5fH43yP5OT4f6PwtQ7sLFhAF3e6eifewpavyn6JC/TU5bYR/2SL1DNz1JsnrvvXq5/KQRLbm9FTvkcYdDHrkVs3sCkN3uwmHm' +
 'AQbElE8rTKEsxqmwZs/dTb9EyJ+d90LFV+/YTd/BK2iWslznV+v8Op1/UOc36/x2nR/U+Y/p/IjOf1rnf0/nH9P5Izp/VOf/ROe/' +
 'rvPf1vnndP6fdP4Vnc/eA/YNDPa9C7Yg7DsX7BsX7PsW7NsW7LsW7JsWbEXYtyzYGrNvWJj4O8XWpwjU+43Tudi3NLL+CznVd1he' +
 'YBvJyjb6Srw+avfg5ge5MfU0mV0bE5axU2cQRAN7Mdir0YlSz5/j1D51yipC7pc7DQ3x9Jva6A/5vB0t5a6W3nJ223V5q8fXibP6' +
 '7K7QHRfyyk40jr+zQzAnzpb63514c3z9TOJso/z9n+46/ePDJ39W7z93tTlmeG9iok3cU5+Renz88ceOXnlroO6Zb/7oP33+7g/L' +
 'p96/2/S+teq3uZaHV27e+8GJ1cf2na6/48n7Gn4fb3/4f93+Q6/lnvn1xgpD4rm/GnZuaPzD5m5T9/GZyeyqT2ouRz86tp1N3j8B' +
 'hFSYlViGAAA=', 'base64'));
let fixtureRoot:string;
let helperPath:string;
beforeAll(()=>{
 fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),'botling-agy-helper-fixture-')));
 helperPath=join(fixtureRoot,'botling-agy-file-helper');
 writeFileSync(helperPath,helperBytes,{mode:0o700});
 const workspace=join(fixtureRoot,'verification-workspace');mkdirSync(workspace);
 // Neither verification nor the real bridge is mocked. Fail if fixture bytes or
 // signatures differ; never repin production to accommodate a test artifact.
 verifyAgyFileHelper(helperPath,workspace);
 execFileSync('/usr/bin/codesign',['--verify','--strict',helperPath],{stdio:'pipe',timeout:10_000});
});
afterAll(()=>{if(fixtureRoot)rmSync(fixtureRoot,{recursive:true,force:true});});
const bridges:AgyMcpBridge[]=[];
afterEach(async()=>{await Promise.all(bridges.splice(0).map(b=>b.close()));});
function setup(){const cwd=mkdtempSync(join(tmpdir(),'botling-agy-mcp-'));mkdirSync(join(cwd,'private-profile'));const b=new AgyMcpBridge(cwd,join(cwd,'private-profile'),undefined,undefined,helperPath);bridges.push(b);return {b,cwd};}
it('no direct invocation or altered arguments can execute without exact allow-once',async()=>{
 const {b,cwd}=setup();await expect(b.invoke('write_file',{path:'a',content:'one'})).rejects.toThrow('No matching');expect(existsSync(join(cwd,'a'))).toBe(false);
 b.grant('botling_write_file',{path:'a',content:'one'});
 await expect(b.invoke('write_file',{path:'a',content:'two'})).rejects.toThrow('No matching');
 await b.invoke('write_file',{content:'one',path:'a'});expect(readFileSync(join(cwd,'a'),'utf8')).toBe('one');
 await expect(b.invoke('write_file',{path:'a',content:'one'})).rejects.toThrow('No matching');
});
it('cancel revokes pending grants and protected/outside writes stay blocked',async()=>{
 const {b}=setup();b.grant('botling_write_file',{path:'a',content:'x'});await b.cancel();await expect(b.invoke('write_file',{path:'a',content:'x'})).rejects.toThrow('No matching');
 b.grant('botling_write_file',{path:'../outside',content:'x'});await expect(b.invoke('write_file',{path:'../outside',content:'x'})).rejects.toThrow('outside');
});
it('cancels a running app-owned command and its child without ACP cooperation',async()=>{
 const {b,cwd}=setup();const command="echo $$ > parent.pid; sleep 60 & echo $! > child.pid; wait";
 b.grant('botling_run_command',{command});const task=b.invoke('run_command',{command});
 for(let i=0;i<100&&!existsSync(join(cwd,'child.pid'));i++)await new Promise(r=>setTimeout(r,10));
 const pid=Number(readFileSync(join(cwd,'child.pid'),'utf8'));await b.close();await task;
 expect(()=>process.kill(pid,0)).toThrow();
});
it('serves HTTP MCP but refuses unapproved tools even with a valid endpoint',async()=>{
 const {b,cwd}=setup(),endpoint=await b.start();
 const call=async(method:string,params:any)=>{const r=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return r.json() as any;};
 expect((await call('initialize',{})).result.serverInfo.name).toBe('botling');
 expect((await call('tools/call',{name:'write_file',arguments:{path:'a',content:'x'}})).result.isError).toBe(true);expect(existsSync(join(cwd,'a'))).toBe(false);
});

it('normalizes the observed ACP MCP envelope without approving changed arguments',async()=>{
 const {b,cwd}=setup();b.grant('botling_write_file',{arguments:{path:'a',content:'yes'},path:'a',content:'yes'});
 await b.invoke('write_file',{path:'a',content:'yes'});expect(readFileSync(join(cwd,'a'),'utf8')).toBe('yes');
 b.grant('botling_write_file',{arguments:{path:'a',content:'no'},path:'a',content:'conflict'});
 await expect(b.invoke('write_file',{path:'a',content:'no'})).rejects.toThrow('No matching');
});

it('approved command still cannot write outside its sandbox or into ACP state',async()=>{
 const {b,cwd}=setup();const outside=mkdtempSync(join(tmpdir(),'botling-agy-outside-'));
 for(const path of [join(outside,'marker'),join(cwd,'private-profile','marker')]){
  const command=`printf bad > '${path}'`;b.grant('botling_run_command',{command});
  const result=await b.invoke('run_command',{command}) as {exitCode:number};expect(result.exitCode).not.toBe(0);expect(existsSync(path)).toBe(false);
 }
});

it('rejects dangling symlinks into outside workspace and protected state',async()=>{
 const {b,cwd}=setup(),outside=mkdtempSync(join(tmpdir(),'agy-link-out-'));
 for(const [index,target] of [join(outside,'absent'),join(cwd,'private-profile','absent')].entries()){
  const path=`link-${index}`;symlinkSync(target,join(cwd,path));b.grant('botling_write_file',{path,content:'BAD'});
  await expect(b.invoke('write_file',{path,content:'BAD'})).rejects.toThrow();expect(existsSync(target)).toBe(false);
 }
});
it('rejects existing symlinks, parent links, protected files and hardlinks before truncation',async()=>{
 const {b,cwd}=setup(),outside=mkdtempSync(join(tmpdir(),'agy-existing-out-'));const fs=await import('node:fs');
 for(const [index,dir] of [outside,join(cwd,'private-profile')].entries()){
  const target=join(dir,'existing');writeFileSync(target,'KEEP');
  symlinkSync(target,join(cwd,`file-${index}`));symlinkSync(dir,join(cwd,`dir-${index}`));fs.linkSync(target,join(cwd,`hard-${index}`));
  for(const path of [`file-${index}`,`dir-${index}/existing`,`hard-${index}`,...(index===1?['private-profile/existing']:[])]){
   b.grant('botling_write_file',{path,content:'BAD'});await expect(b.invoke('write_file',{path,content:'BAD'})).rejects.toThrow();
   b.grant('botling_read_file',{path});await expect(b.invoke('read_file',{path})).rejects.toThrow();
  }
  expect(readFileSync(target,'utf8')).toBe('KEEP');
 }
});
it('concurrent parent replacement never redirects writes to outside/protected targets',async()=>{
 const {b,cwd}=setup(),outside=mkdtempSync(join(tmpdir(),'agy-race-out-'));const {spawn}=await import('node:child_process');
 for(const dir of [outside,join(cwd,'private-profile')])writeFileSync(join(dir,'victim'),'KEEP');
 mkdirSync(join(cwd,'slot'));writeFileSync(join(cwd,'slot','victim'),'owned');
 let swaps=0;const racer=spawn(process.execPath,['-e',`const fs=require('fs'),[root,out,profile]=process.argv.slice(1);let i=0;setInterval(()=>{try{fs.renameSync(root+'/slot',root+'/park');fs.symlinkSync(i++%2?out:profile,root+'/slot');fs.unlinkSync(root+'/slot');fs.renameSync(root+'/park',root+'/slot');process.send(i);}catch{}},0);`,cwd,outside,join(cwd,'private-profile')],{stdio:['ignore','ignore','ignore','ipc']});
 racer.on('message',n=>{swaps=Number(n);});await new Promise(r=>racer.once('message',r));
 try {for(let i=0;i<80;i++){b.grant('botling_write_file',{path:'slot/victim',content:'owned'});await b.invoke('write_file',{path:'slot/victim',content:'owned'}).catch(()=>{});}}
 finally{racer.kill();await new Promise(r=>racer.once('exit',r));}
 expect(swaps).toBeGreaterThan(1);for(const dir of [outside,join(cwd,'private-profile')])expect(readFileSync(join(dir,'victim'),'utf8')).toBe('KEEP');
});
it('worker tools remain unavailable even when a caller supplies a delegate',async()=>{
 const {cwd}=setup();let called=false;const b=new AgyMcpBridge(cwd,join(cwd,'private-profile'),async()=>{called=true;});bridges.push(b);
 expect(b.tools.map(t=>t.name)).toEqual(['read_file','write_file','run_command']);
 b.grant('botling_app_handoff',{instructions:'test'});await expect(b.invoke('app_handoff',{instructions:'test'})).rejects.toThrow('Unsupported');expect(called).toBe(false);
});

it('workspace directory replacement fails its pinned identity check',async()=>{
 const {b,cwd}=setup();const fs=await import('node:fs');fs.renameSync(cwd,cwd+'-original');mkdirSync(cwd);writeFileSync(join(cwd,'target'),'KEEP');
 b.grant('botling_write_file',{path:'target',content:'BAD'});await expect(b.invoke('write_file',{path:'target',content:'BAD'})).rejects.toThrow();expect(readFileSync(join(cwd,'target'),'utf8')).toBe('KEEP');
});

it('refuses tampered or symlinked provisioned helpers before a granted write',async()=>{
 const {cwd}=setup();
 const tampered=join(fixtureRoot,'tampered-helper'),linked=join(fixtureRoot,'linked-helper');
 const bytes=Buffer.from(helperBytes);bytes[bytes.length-1]^=1;
 writeFileSync(tampered,bytes,{mode:0o700});symlinkSync(helperPath,linked);
 for(const [path,error] of [[tampered,'hash mismatch'],[linked,'Canonical verified']] as const){
  const bridge=new AgyMcpBridge(cwd,join(cwd,'private-profile'),undefined,undefined,path);bridges.push(bridge);
  bridge.grant('botling_write_file',{path:'blocked',content:'BAD'});
  await expect(bridge.invoke('write_file',{path:'blocked',content:'BAD'})).rejects.toThrow(error);
  expect(existsSync(join(cwd,'blocked'))).toBe(false);
 }
});

it('filePath aliases share exact one-action grants with canonical paths and retain containment',async()=>{
 const {b,cwd}=setup();
 const args={filePath:'alias.txt',content:'approved'};
 b.grant('botling_write_file',{arguments:args,...args});
 await expect(b.invoke('write_file',{...args,content:'changed'})).rejects.toThrow('No matching');
 await b.invoke('write_file',{path:'alias.txt',content:'approved'});
 expect(readFileSync(join(cwd,'alias.txt'),'utf8')).toBe('approved');
 await expect(b.invoke('write_file',args)).rejects.toThrow('No matching');
 b.grant('botling_read_file',{path:'alias.txt'});
 expect(await b.invoke('read_file',{filePath:'alias.txt'})).toBe('approved');
 for(const filePath of ['../outside','private-profile/blocked']){
  b.grant('botling_write_file',{filePath,content:'denied'});
  await expect(b.invoke('write_file',{filePath,content:'denied'})).rejects.toThrow(/outside|Protected|Workspace file access refused/);
  expect(existsSync(join(cwd,filePath))).toBe(false);
 }
 b.grant('botling_write_file',{arguments:args,...args,content:'conflict'});
 await expect(b.invoke('write_file',args)).rejects.toThrow('No matching');
 for(const input of [{path:'different',...args},{arguments:args,path:'different'},{arguments:{path:'alias.txt',content:'approved'},filePath:'different'}]){
  b.grant('botling_write_file',input);
  await expect(b.invoke('write_file',args)).rejects.toThrow('No matching');
 }
});
