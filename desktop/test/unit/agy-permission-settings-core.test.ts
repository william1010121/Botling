import {expect,it} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {CoreHarness} from '../core-harness';
import {tempDir} from '../helpers';
it('persists Antigravity selection through real core IPC and restart without enabling other engines',async()=>{
 const dir=tempDir('agy-permission-settings'),file=join(dir,'settings.json');writeFileSync(file,JSON.stringify({future:true,claudeBypassPermissions:false,codexBypassPermissions:false}));
 const env={BOTLING_ROUTINE_TICK_MS:'0',BOTLING_COMPONENT_SCAN_MS:'0',BOTLING_IMPORT_FROM:join(dir,'no-import'),HOME:dir};
 let core=new CoreHarness(dir,env);
 try{await core.call({type:'boot.commit'});expect((await core.call({type:'settings.get'})).agyBypassPermissions).toBe(false);
 await core.call({type:'settings.set',change:{key:'agyBypassPermissions',value:true}});expect(JSON.parse(readFileSync(file,'utf8'))).toMatchObject({agyBypassPermissions:true,claudeBypassPermissions:false,codexBypassPermissions:false,future:true});
 await core.kill();core=new CoreHarness(dir,env);await core.call({type:'boot.commit'});expect(await core.call({type:'settings.get'})).toMatchObject({agyBypassPermissions:true,agyPermissionSessions:[]});
 expect(await core.call({type:'settings.set',change:{key:'agyBypassPermissions',value:false}})).toMatchObject({agyBypassPermissions:false});
 }finally{await core.kill();}
});
