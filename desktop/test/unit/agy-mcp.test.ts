import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,symlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {AgyMcpBridge} from '../../src/core/agent/agy-mcp';
const bridges:AgyMcpBridge[]=[];
afterEach(async()=>{await Promise.all(bridges.splice(0).map(b=>b.close()));});
function setup(){const cwd=mkdtempSync(join(tmpdir(),'botling-agy-mcp-'));mkdirSync(join(cwd,'private-profile'));const b=new AgyMcpBridge(cwd,join(cwd,'private-profile'),undefined,undefined,resolve('.cache/agy-acp-dev/server/botling-agy-file-helper'));bridges.push(b);return {b,cwd};}
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
