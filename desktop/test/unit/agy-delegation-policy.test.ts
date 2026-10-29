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
