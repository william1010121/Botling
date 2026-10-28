import { expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreHarness } from '../core-harness';
import { tempDir } from '../helpers';
it('core rejects invalid runtime settings without losing saved values and reports missing runtime', async () => {
 const dir = tempDir('agy-settings-core'), file = join(dir,'settings.json');
 writeFileSync(file,JSON.stringify({future:true,agyAcpPath:'/previous'}));
 const core = new CoreHarness(dir,{BOTLING_AGY_ACP_PATH:'',BOTLING_ROUTINE_TICK_MS:'0',BOTLING_COMPONENT_SCAN_MS:'0'});
 try {
  await expect(core.call({type:'settings.set',change:{key:'agyAcpPath',value:'agy'}})).rejects.toThrow('Settings → Engines and subagents → Antigravity');
  expect(JSON.parse(readFileSync(file,'utf8'))).toEqual({future:true,agyAcpPath:'/previous'});
  expect((await core.call({type:'settings.set',change:{key:'agyAcpPath',value:null}})).agyAcpPath).toBeNull();
  expect(core.of('settings.updated').at(-1)?.event).toMatchObject({settings:{agyAcpPath:null}});
  expect(await core.call({type:'agy.runtime.check'})).toMatchObject({valid:false,effective:null,message:expect.stringContaining('not configured')});
 } finally { await core.kill(); }
});
it.skipIf(!process.env.BOTLING_TEST_OFFICIAL_ACP)('core saves a verified runtime, reloads it, and never falls back from a broken environment override', async () => {
 const path = process.env.BOTLING_TEST_OFFICIAL_ACP!, dir = tempDir('agy-official-settings-core');
 const env = {BOTLING_AGY_ACP_PATH:'',BOTLING_ROUTINE_TICK_MS:'0',BOTLING_COMPONENT_SCAN_MS:'0'};
 let core = new CoreHarness(dir,env);
 try {
  expect((await core.call({type:'settings.set',change:{key:'agyAcpPath',value:path}})).agyAcpPath).toBe(path);
  expect(await core.call({type:'agy.runtime.check'})).toMatchObject({valid:true,effective:path,override:null});
  await core.kill(); core = new CoreHarness(dir,{...env,BOTLING_AGY_ACP_PATH:'broken-override'});
  expect((await core.call({type:'settings.get'})).agyAcpPath).toBe(path);
  expect(await core.call({type:'agy.runtime.check'})).toMatchObject({valid:false,effective:'broken-override',message:expect.stringContaining('overrides the saved setting')});
 } finally { await core.kill(); }
},30000);
