import {expect,it} from 'vitest';
import {agyWorkerRuntimeEnabled,agyMixedRuntimeEnabled,agyPairAllowed} from '../../src/core/agent/agy-capabilities';
import {createAgyWorkerHead} from '../../src/core/agent/agy-worker-router';
import {AgyCodexHead} from '../../src/core/agent/agy-codex-head';
it('production gates cannot create a worker or mixed head, including Claude routes',()=>{
 expect(agyWorkerRuntimeEnabled()).toBe(false);expect(agyMixedRuntimeEnabled()).toBe(false);
 for(const a of ['agy','codex','claude'] as const)for(const b of ['agy','codex','claude'] as const)expect(agyPairAllowed(a,b)).toBe(false);
 let created=false;
 expect(()=>createAgyWorkerHead({} as any,{} as any,()=>{created=true;throw Error('must not create');})).toThrow('disabled');
 expect(()=>new AgyCodexHead({} as any,{} as any)).toThrow('disabled');expect(created).toBe(false);
});
