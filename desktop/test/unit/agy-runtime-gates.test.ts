import {expect,it} from 'vitest';
import {agyWorkerRuntimeEnabled,agyMixedRuntimeEnabled,agyPairAllowed} from '../../src/core/agent/agy-capabilities';
import {createAgyWorkerHead} from '../../src/core/agent/agy-worker-router';
import {AgyCodexHead} from '../../src/core/agent/agy-codex-head';
it('production gates: agy-only workers on, mixed and cross-engine routes still closed',()=>{
 expect(agyWorkerRuntimeEnabled()).toBe(true);expect(agyMixedRuntimeEnabled()).toBe(false);
 for(const a of ['agy','codex','claude'] as const)for(const b of ['agy','codex','claude'] as const)expect(agyPairAllowed(a,b)).toBe(false);
 let created=false;
 createAgyWorkerHead({} as any,{} as any,()=>{created=true;return {} as any;});expect(created).toBe(true);
 expect(()=>new AgyCodexHead({} as any,{} as any)).toThrow('disabled');
});
it('the real agy bot prompt advertises app-managed delegation with the gate on',async()=>{
 const {botPrompts}=await import('../../src/core/prompts');
 const p=botPrompts({profile:{name:'Probe',role:'bot' as const,folder:'/fixture',memoryPath:'.bot/memory.md',job:null},engine:'agy'});
 expect(p.system).toContain('You are the coordinator, not an execution worker');
 expect(p.system).toContain('app_task_checkpoint');expect(p.system).not.toContain('Work directly on');
});
