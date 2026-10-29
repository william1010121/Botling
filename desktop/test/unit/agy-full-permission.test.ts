import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {AgyMcpBridge} from '../../src/core/agent/agy-mcp';
import {AgyAcpProtocol} from '../../src/core/agent/agy-acp';
import * as tree from '../../src/core/process/tree';
import {applySetting,launchSettings,readSettings,settingsView,writeSettings} from '../../src/core/settings';
import {SettingsChange} from '../../src/contract';
import {registerAgyPermissions,changeAgyPermissions,agyPermissionSessions,forgetAgyPermissions} from '../../src/core/agent/agy-permissions';
const roots:string[]=[],bridges:AgyMcpBridge[]=[],owners:object[]=[];
afterEach(async()=>{await Promise.all(bridges.splice(0).map(b=>b.close()));for(const p of roots.splice(0))rmSync(p,{recursive:true,force:true});for(const o of owners.splice(0))forgetAgyPermissions(o);vi.restoreAllMocks();});
function setup(full:()=>boolean=()=>false){const root=mkdtempSync(join(tmpdir(),'agy-full-'));roots.push(root);const cwd=join(root,'project'),home=join(root,'profile');mkdirSync(cwd);mkdirSync(home);const bridge=new AgyMcpBridge(cwd,home,undefined,undefined,undefined,full);bridges.push(bridge);bridge.beginTurn();return {root,cwd,home,bridge};}
it('persists only explicit boolean selection, defaulting off and retaining other engines',()=>{
 const {root}=setup(),file=join(root,'settings.json');
 expect(settingsView({}).agyBypassPermissions).toBe(false);expect(launchSettings({agyBypassPermissions:'true'}).agyBypassPermissions).toBe(false);
 expect(()=>SettingsChange.parse({key:'agyBypassPermissions',value:'true'})).toThrow();
 for(const value of [true,false]){writeSettings(file,applySetting({future:42,claudeBypassPermissions:false,codexBypassPermissions:true},SettingsChange.parse({key:'agyBypassPermissions',value})));const saved=readSettings(file);expect(saved).toEqual({future:42,claudeBypassPermissions:false,codexBypassPermissions:true,agyBypassPermissions:value});expect(launchSettings(saved).agyBypassPermissions).toBe(value);}
});
it('full file access follows OS paths across workspace boundary; another bridge and revoked turns remain denied',async()=>{
 let active=true;const a=setup(()=>active),b=setup();const path=join(a.root,'outside.txt');
 await a.bridge.invoke('write_file',{path,content:'explicit full permission'});expect(await a.bridge.invoke('read_file',{path})).toBe('explicit full permission');
 await expect(b.bridge.invoke('read_file',{path})).rejects.toThrow('No matching');
 active=false;a.bridge.revoke();await expect(a.bridge.invoke('write_file',{path,content:'stale'})).rejects.toThrow('No matching');expect(readFileSync(path,'utf8')).toBe('explicit full permission');
 active=true;await expect(a.bridge.invoke('app_handoff',{instructions:'not authorized'})).rejects.toThrow('Unsupported');
});
it('default exact grant still rejects changed arguments and is consumed once',async()=>{
 const {bridge}=setup();bridge.grant('botling_write_file',{path:'../outside',content:'one'});
 await expect(bridge.invoke('write_file',{path:'../outside',content:'two'})).rejects.toThrow('No matching');
 await expect(bridge.invoke('write_file',{path:'../outside',content:'one'})).rejects.toThrow('outside');
 await expect(bridge.invoke('write_file',{path:'../outside',content:'one'})).rejects.toThrow('No matching');
});
it('full shell uses OS shell, default uses sandbox; cancellation terminates the tracked stub process',async()=>{
 const spawned:any[]=[];
 vi.spyOn(tree,'processTreeAdapter').mockReturnValue({platform:'darwin',verified:true,spawn:(file,args,options)=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough()});
  const terminate=vi.fn(async()=>{queueMicrotask(()=>child.emit('close',0));return {killed:[],forced:false};});spawned.push({file,args,options,child,terminate});return {pid:123,child,terminate} as any;
 }});
 let active=true;const {bridge}=setup(()=>active);const command='fixture command NEVER executed';
 const first=bridge.invoke('run_command',{command});expect(spawned[0].file).toBe('/bin/sh');expect(spawned[0].args).toEqual(['-c',command]);
 active=false;await bridge.cancel();await first;expect(spawned[0].terminate).toHaveBeenCalled();
 await expect(bridge.invoke('run_command',{command})).rejects.toThrow('No matching');
 bridge.grant('botling_run_command',{command});const second=bridge.invoke('run_command',{command});expect(spawned[1].file).toBe('/usr/bin/sandbox-exec');spawned[1].child.emit('close',0);await second;
});
it('mode change revokes live heads before returning and leaves matching sessions alone',()=>{
 const a={},b={};owners.push(a,b);const revoke=vi.fn(),unchanged=vi.fn();registerAgyPermissions(a,{sessionId:'a',mode:'yolo',state:'active',message:'active'},revoke);registerAgyPermissions(b,{sessionId:'b',mode:'default',state:'ready',message:'ready'},unchanged);
 changeAgyPermissions(false);expect(revoke).toHaveBeenCalledOnce();expect(unchanged).not.toHaveBeenCalled();expect(agyPermissionSessions().find(s=>s.sessionId==='a')?.state).toBe('stopped');changeAgyPermissions(false);expect(revoke).toHaveBeenCalledOnce();
});
it('HTTP rejects foreign token/origin and requests crossing a revocation epoch',async()=>{
 const {bridge,root}=setup(()=>true),endpoint=await bridge.start();const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'write_file',arguments:{path:join(root,'outside'),content:'no'}}});
 expect((await fetch(endpoint.url+'foreign',{method:'POST',body})).status).toBe(403);
 expect((await fetch(endpoint.url,{method:'POST',headers:{origin:'http://foreign'},body})).status).toBe(403);
 const response=new Promise<number>((resolve,reject)=>{
  const req=request(endpoint.url,{method:'POST',headers:{'content-length':Buffer.byteLength(body)}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.write(body.slice(0,10));
  // Wait until the bridge has received the first chunk, then revoke before the body completes.
  (bridge as any).server.once('request',()=>{setImmediate(()=>{bridge.revoke();req.end(body.slice(10));});});
 });
 expect(await response).toBe(409);
});

it('negotiated protocol capability and bridge turn epoch work together and revoke without cached grants',async()=>{
 const frames:any[]=[],errors:Error[]=[],tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
 let protocol:AgyAcpProtocol;
 const {bridge,root}=setup(()=>protocol?.fullPermissionActive===true);
 protocol=new AgyAcpProtocol({command:'stub',cwd:root,sessionId:'owned',resume:false,bypassPermissions:true},m=>frames.push(m),()=>{},e=>errors.push(e),{revoke:()=>bridge.revoke(),onPolicy:state=>{if(state==='active')bridge.beginTurn();}});
 const reply=(result:any)=>protocol.receive({jsonrpc:'2.0',id:frames.findLast(f=>f.method&&f.id).id,result});
 const path=join(root,'outside.txt'),args={path,content:'active only'};
 try{
 const done=protocol.send('task','one');await expect(bridge.invoke('write_file',args)).rejects.toThrow('No matching');
 reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'}});await tick();reply({sessionId:'owned'});await tick();
 for(let i=0;i<3;i++){await expect(bridge.invoke('write_file',args)).rejects.toThrow('No matching');reply({configOptions:[{id:'mode',currentValue:'yolo'}]});await tick();}
 await bridge.invoke('write_file',args);expect(readFileSync(path,'utf8')).toBe('active only');
 const prompt=frames.at(-1).id;protocol.interrupt();await expect(bridge.invoke('write_file',args)).rejects.toThrow('No matching');
 protocol.receive({jsonrpc:'2.0',id:prompt,result:{stopReason:'end_turn'}});await done;
 expect(errors).toEqual([]);await expect(bridge.invoke('write_file',args)).rejects.toThrow('No matching');
 }finally{protocol.close();}
});

// ACP 1.4.3 transcript steps 47/48 supplied content + filePath despite the
// advertised path field. rawInput additionally mirrors these under arguments.
it('executes observed filePath calls over MCP and keeps command dispatch independent',async()=>{
 const {bridge,cwd}=setup(()=>true),endpoint=await bridge.start();
 const call=async(name:string,args:unknown)=>{
  const response=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  return (await response.json() as any).result;
 };
 const written=await call('write_file',{content:'{"version":2}',filePath:'report.json'});
 expect(written).toMatchObject({isError:false});
 expect(readFileSync(join(cwd,'report.json'),'utf8')).toBe('{"version":2}');
 expect(await call('read_file',{filePath:'report.json'})).toMatchObject({isError:false,content:[{text:'{"version":2}'}]});
 expect(await call('run_command',{command:"printf 'command-ok'"})).toMatchObject({isError:false,content:[{text:JSON.stringify({exitCode:0,output:'command-ok'})}]});
 expect(await call('write_file',{content:'missing'})).toMatchObject({isError:true,content:[{text:'Path required.'}]});
 expect(await call('run_command',{})).toMatchObject({isError:true,content:[{text:'Command required.'}]});
});

it('full permission rejects missing or conflicting file paths without changing files',async()=>{
 const {bridge,cwd}=setup(()=>true);writeFileSync(join(cwd,'keep'),'KEEP');
 for(const args of [{}, {filePath:''}, {path:' '}, {filePath:42}, {path:'keep',filePath:'other'}, {path:'keep',filePath:null}]){
  await expect(bridge.invoke('write_file',{...args,content:'BAD'})).rejects.toThrow(/Path required|Conflicting path/);
 }
 expect(readFileSync(join(cwd,'keep'),'utf8')).toBe('KEEP');
 await bridge.invoke('write_file',{path:'keep',filePath:'keep',content:'same explicit path'});
 expect(readFileSync(join(cwd,'keep'),'utf8')).toBe('same explicit path');
});
