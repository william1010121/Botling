import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Core } from '../../src/core/server';
import { AgyRuntimeInstaller } from '../../src/core/agy-runtime-install';
import * as runtime from '../../src/core/agy-runtime-settings';
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, type Outbound } from '../../src/contract';
import { tempDir, until } from '../helpers';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture() {
 const dir=tempDir('agy-doctor-core'), emitted: Outbound[]=[];
 writeFileSync(join(dir,'settings.json'),JSON.stringify({future:'preserve',agyAcpPath:'/previous'}));
 const core=new Core({dataDir:dir,headConfig:(_p,s)=>({command:process.execPath,cwd:dir,sessionId:s.sessionId,resume:false,allowedTools:[]}),emit:m=>emitted.push(m),deferStartup:true,routineTickMs:0,componentScanMs:0,waitingScanMs:0,watchMs:0,quitTidyMs:0,oneX:{folder:null,process:/never/}});
 let count=0;
 const call=async(cmd:unknown)=>{const id=`agy-${++count}`;await core.receive({v:PROTOCOL_VERSION,id,cmd});return await until(()=>emitted.find(m=>'id' in m&&m.id===id)) as any;};
 await call({type:'boot.commit'});
 return {core,dir,emitted,call};
}
it('configures the installed runtime, preserves unrelated settings and broadcasts after explicit IPC',async()=>{
 vi.stubEnv('BOTLING_AGY_ACP_PATH','');
 const install=vi.spyOn(AgyRuntimeInstaller.prototype,'install').mockResolvedValue('/local/1.4.3/agy_acp_server.par');
 vi.spyOn(runtime,'validateAgyRuntimePath').mockImplementation(()=>{});
 const f=await fixture();
 try {
  expect(Command.safeParse({type:'agy.runtime.install',destination:'/Volumes/evil'}).success).toBe(false);
  expect(RENDERER_COMMANDS.has('agy.runtime.install')).toBe(true);
  const view=await f.call({type:'doctor.run',includeLatest:false});
  expect(view.ok).toBe(true);expect(view.result.checks.some((c:any)=>c.tool==='antigravity')).toBe(true);
  expect(install).not.toHaveBeenCalled();
  expect((await f.call({type:'agy.runtime.install'})).ok).toBe(true);
  expect(install).toHaveBeenCalledExactlyOnceWith(f.dir);
  expect(JSON.parse(readFileSync(join(f.dir,'settings.json'),'utf8'))).toMatchObject({future:'preserve',agyAcpPath:'/local/1.4.3/agy_acp_server.par'});
  expect(f.emitted.some(m=>'event' in m&&m.event.type==='settings.updated')).toBe(true);
 } finally {await f.core.shutdown();}
},30000);
it('failed installation and an environment override leave settings untouched',async()=>{
 vi.stubEnv('BOTLING_AGY_ACP_PATH','');
 const install=vi.spyOn(AgyRuntimeInstaller.prototype,'install').mockRejectedValue(Error('signature mismatch'));
 const f=await fixture();
 try {
  const before=readFileSync(join(f.dir,'settings.json'),'utf8');
  const failed=await f.call({type:'agy.runtime.install'});
  expect(failed).toMatchObject({ok:false,error:{message:expect.stringContaining('signature mismatch')}});
  expect(readFileSync(join(f.dir,'settings.json'),'utf8')).toBe(before);
  vi.stubEnv('BOTLING_AGY_ACP_PATH','/external/override');
  expect(await f.call({type:'agy.runtime.install'})).toMatchObject({ok:false,error:{message:expect.stringContaining('overrides saved settings')}});
  expect(install).toHaveBeenCalledTimes(1);
  expect(readFileSync(join(f.dir,'settings.json'),'utf8')).toBe(before);
 } finally {await f.core.shutdown();}
});
