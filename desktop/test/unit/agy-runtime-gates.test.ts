import {expect,it} from 'vitest';
import {agyWorkerRuntimeEnabled} from '../../src/core/agent/agy-capabilities';
import {createAgyWorkerHead} from '../../src/core/agent/agy-worker-router';
it('production gates: agy-only workers on, cross-engine workers still closed',()=>{
 expect(agyWorkerRuntimeEnabled()).toBe(true);
 let created=false;
 createAgyWorkerHead({} as any,{} as any,()=>{created=true;return {} as any;});expect(created).toBe(true);
 expect(()=>createAgyWorkerHead({workerEngine:'codex'} as any,{} as any,()=>({}) as any)).toThrow('cross-engine');
});
it('the real agy bot prompt advertises app-managed delegation with the gate on',async()=>{
 const {botPrompts}=await import('../../src/core/prompts');
 const p=botPrompts({profile:{name:'Probe',role:'bot' as const,folder:'/fixture',memoryPath:'.bot/memory.md',job:null},engine:'agy'});
 expect(p.system).toContain('You are the coordinator, not an execution worker');
 expect(p.system).toContain('app_task_checkpoint');expect(p.system).not.toContain('Work directly on');
});
