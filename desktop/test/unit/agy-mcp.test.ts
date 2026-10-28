import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgyMcpBridge} from '../../src/core/agent/agy-mcp';
const bridges:AgyMcpBridge[]=[];
afterEach(async()=>{await Promise.all(bridges.splice(0).map(b=>b.close()));});
function setup(){const cwd=mkdtempSync(join(tmpdir(),'botling-agy-mcp-'));mkdirSync(join(cwd,'private-profile'));const b=new AgyMcpBridge(cwd,join(cwd,'private-profile'));bridges.push(b);return {b,cwd};}
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
