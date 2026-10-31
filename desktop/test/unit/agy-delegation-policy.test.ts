import {expect,it,vi} from 'vitest';
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true}));
import {botPrompts} from '../../src/core/prompts';
import {AGY_WORKER_TOOLS} from '../../src/core/agent/agy-mcp';
const profile={name:'Probe',role:'bot' as const,folder:'/fixture',memoryPath:'.bot/memory.md',job:null};
it('uses a coordinator policy when managed transport is available, with distinct worker instructions',()=>{
 const p=botPrompts({profile,engine:'agy'});
 expect(p.system).toContain('You are the coordinator, not an execution worker');
 for(const contract of ['research-only','implementation_authorized=false','file_release_authorizes_implementation=false','isolated git worktree','END YOUR CURRENT TURN','app_task_checkpoint'])expect(p.system).toContain(contract);
 expect(p.system).not.toContain('Work directly on');expect(p.system).not.toContain('app_monitor_start');expect(p.system).not.toContain('app_routines');
 expect(p.codexWorkerSystem).toContain('research/design-only');expect(p.codexWorkerSystem).not.toContain('You are the coordinator');
 expect(AGY_WORKER_TOOLS.map(t=>t.name)).toContain('app_task_checkpoint');
});
it('exposes only coordinator tools and keeps cross-engine dispatch gated',async()=>{
 const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {AgyMcpBridge}=await import('../../src/core/agent/agy-mcp');
 const dir=mkdtempSync(join(tmpdir(),'agy-policy-')),home=join(dir,'home');mkdirSync(home);
 const dispatch=vi.fn();const bridge=new AgyMcpBridge(dir,home,dispatch);
 try{
  const names=bridge.tools.map(t=>t.name);expect(names).toContain('app_handoff');expect(names).toContain('app_task_checkpoint');expect(names).not.toContain('run_command');expect(names).not.toContain('read_file');
  const args={instructions:'task',engine:'codex'};bridge.grant('botling_app_handoff',args);
  await expect(bridge.invoke('app_handoff',args)).rejects.toThrow('Cross-engine');expect(dispatch).not.toHaveBeenCalled();
 }finally{await bridge.close();rmSync(dir,{recursive:true,force:true});}
});
it('dispatches coordination tools and reconcile without an approval card',async()=>{
 const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {AgyMcpBridge}=await import('../../src/core/agent/agy-mcp');
 const dir=mkdtempSync(join(tmpdir(),'agy-handoff-auto-')),home=join(dir,'home');mkdirSync(home);
 const items:any[]=[],dispatch=vi.fn(async()=>({task_id:'task-1',status:'accepted'}));
 const bridge=new AgyMcpBridge(dir,home,dispatch,undefined,undefined,undefined,item=>items.push(item));
 try{
  const endpoint=await bridge.start();bridge.beginTurn();
  const call=(id:number,name:string,args:any)=>fetch(endpoint.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})}).then(r=>r.json());
  await expect(call(1,'app_handoff',{instructions:'authorized task',name:'fixture'})).resolves.toMatchObject({result:{isError:false}});
  await expect(call(2,'app_send_message',{task_id:'task-1',run:1,message:'go on'})).resolves.toMatchObject({result:{isError:false}});
  await expect(call(3,'app_task_checkpoint',{task_id:'task-1',run:1,outcome:'complete',evidence:'ok'})).resolves.toMatchObject({result:{isError:false}});
  expect(dispatch).toHaveBeenCalledTimes(3);
  expect(items.some(item=>item.kind==='permission')).toBe(false);
  // Reconcile also dispatches directly, with no card.
  await expect(call(4,'app_reconcile_report',{task_id:'task-1',run:1,action:'acknowledge'})).resolves.toMatchObject({result:{isError:false}});
  expect(dispatch).toHaveBeenCalledTimes(4);
  expect(items.some(item=>item.kind==='permission')).toBe(false);
 }finally{await bridge.close();rmSync(dir,{recursive:true,force:true});}
});
