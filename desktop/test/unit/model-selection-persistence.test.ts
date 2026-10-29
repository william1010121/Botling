import { expect,it } from 'vitest';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import {join} from 'node:path';
import {Bot} from '../../src/core/bot';
import {ProcessLedger} from '../../src/core/process/ledger';
import {mainProfile} from '../../src/core/store/workspace';
import {Command,BotSettingsView} from '../../src/contract';
import {tempDir} from '../helpers';
it('persists discovered Claude/subagent IDs and defaults without changing engine routing',async()=>{
 const dir=tempDir('model-persistence'),profile=mainProfile(dir);mkdirSync(profile.storeDir,{recursive:true});
 const file=join(profile.storeDir,'bot.json');
 writeFileSync(file,JSON.stringify({engine:'claude',heads:{engines:['claude','codex','agy'],answerWith:'agy'},model:'old-custom',subagentModel:'old-subagent',agyModel:'old-agy'}));
 const make=()=>new Bot({profile,deferStartup:true,welcome:false,ledger:new ProcessLedger(join(dir,'ledger.json')),headConfig(){throw Error('No inference authorized');},prompts:()=>({system:''}) as any,emit(){},log(){},approvalTimeoutMs:100,idleMs:60000,interruptGraceMs:10});
 let bot=make();
 try {
  expect(BotSettingsView.parse(bot.settingsView())).toMatchObject({model:'old-custom',subagentModel:'old-subagent'});
  const before=JSON.parse(readFileSync(file,'utf8')).heads;
  expect(Command.safeParse({type:'bot.configure',botId:profile.id,model:'new-provider-model',subagentModel:'new-subagent-model'}).success).toBe(true);
  bot.configure({model:'new-provider-model',subagentModel:'new-subagent-model',codexModel:'new-codex',agyModel:'new-agy'});
  expect(JSON.parse(readFileSync(file,'utf8')).heads).toMatchObject({engines:before.engines,answerWith:before.answerWith});
  await bot.shutdown({tidy:false});bot=make();
  expect(bot.settingsView()).toMatchObject({model:'new-provider-model',subagentModel:'new-subagent-model',codexModel:'new-codex',agyModel:'new-agy'});
  bot.configure({model:null,subagentModel:null,codexModel:null,agyModel:null});
  expect(bot.settingsView()).toMatchObject({model:null,subagentModel:null,codexModel:null,agyModel:null});
  expect(Command.safeParse({type:'bot.configure',botId:profile.id,model:'bad\nmodel'}).success).toBe(false);
 } finally {await bot.shutdown({tidy:false});}
});

it('validates and routes discovery IPC without changing bot settings',async()=>{
 const {Core}=await import('../../src/core/server');
 const {RENDERER_COMMANDS}=await import('../../src/contract');
 const {until}=await import('../helpers');
 const dir=tempDir('model-ipc'),messages:any[]=[],queries:any[]=[];
 const core=new Core({dataDir:dir,deferStartup:true,quitTidyMs:0,routineTickMs:0,watchMs:0,componentScanMs:0,waitingScanMs:0,
  headConfig(){throw Error('No inference authorized');},emit:m=>messages.push(m),
  engineModels:async(engine,profile)=>{queries.push({engine,id:profile.id});return {status:'ready',source:'fixture runtime',models:[{id:'runtime-model',name:'Runtime model',isDefault:true,efforts:null}],message:'Catalog'};},
 });
 const call=async(cmd:any,id:string)=>{core.receive({v:10,id,cmd});return await until(()=>messages.find(m=>m.id===id));};
 try {
  const botId=mainProfile(dir).id;
  expect(RENDERER_COMMANDS.has('engine.models')).toBe(true);
  expect((await call({type:'engine.models',botId,engine:'agy'},'staging')).error.code).toBe('conflict');
  await call({type:'boot.commit'},'commit');
  const before=await call({type:'bot.settings',botId},'before');
  const result=await call({type:'engine.models',botId,engine:'agy'},'models');
  expect(result, JSON.stringify(result)).toMatchObject({ok:true,result:{status:'ready',models:[{id:'runtime-model'}]}});
  expect(queries).toEqual([{engine:'agy',id:botId}]);
  expect((await call({type:'bot.settings',botId},'after')).result).toEqual(before.result);
  expect((await call({type:'engine.models',botId,engine:'invented'},'bad')).ok).toBe(false);
 }finally{await core.shutdown();}
});
