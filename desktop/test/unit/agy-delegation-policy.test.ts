import {expect,it,vi} from 'vitest';
vi.mock('../../src/core/agent/agy-capabilities',()=>({agyWorkerRuntimeEnabled:()=>true,agyMixedRuntimeEnabled:()=>false}));
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
it('shows an exact one-shot approval and waits before dispatching an app handoff',async()=>{
 const {mkdtempSync,mkdirSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {AgyMcpBridge}=await import('../../src/core/agent/agy-mcp');
 const {AgyAcpHead}=await import('../../src/core/agent/agy-acp');
 const dir=mkdtempSync(join(tmpdir(),'agy-handoff-approval-')),home=join(dir,'home');mkdirSync(home);
 const items:any[]=[],dispatch=vi.fn(async()=>({task_id:'task-1',status:'accepted'}));
 const bridge=new AgyMcpBridge(dir,home,dispatch,undefined,undefined,undefined,item=>items.push(item));
 const head=new AgyAcpHead({} as any,{onItem(){},onExit(){}} as any);(head as any).bridge=bridge;
 try{
  const endpoint=await bridge.start();bridge.beginTurn();
  const pending=fetch(endpoint.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'app_handoff',arguments:{instructions:'authorized task',name:'fixture'}}})}).then(r=>r.json());
  for(let i=0;i<50&&!items.some(item=>item.kind==='permission');i++)await new Promise(resolve=>setTimeout(resolve,2));
  const card=items.find(item=>item.kind==='permission');
  expect(card).toMatchObject({tool:'app_handoff',input:{instructions:'authorized task',name:'fixture'}});
  expect(dispatch).not.toHaveBeenCalled();
  head.answer(card.requestId,true,card.input);
  await expect(pending).resolves.toMatchObject({result:{isError:false}});
  expect(dispatch).toHaveBeenCalledTimes(1);
  const denied=fetch(endpoint.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'app_handoff',arguments:{instructions:'separate task',name:'denied'}}})}).then(r=>r.json());
  for(let i=0;i<50&&!items.some(item=>item.kind==='permission'&&item.input.instructions==='separate task');i++)await new Promise(resolve=>setTimeout(resolve,2));
  const deniedCard=items.find(item=>item.kind==='permission'&&item.input.instructions==='separate task');
  expect(deniedCard).toBeDefined();head.answer(deniedCard.requestId,false,deniedCard.input);
  await expect(denied).resolves.toMatchObject({result:{isError:true}});
  expect(dispatch).toHaveBeenCalledTimes(1);
 }finally{await bridge.close();rmSync(dir,{recursive:true,force:true});}
});
