import {expect,it} from 'vitest';
import {botPrompts,desktopPrompts} from '../../src/core/prompts';
import {AgyAcpProtocol} from '../../src/core/agent/agy-acp';

it('delivers report rules and conditional permission instructions on new and resumed ACP sessions',async()=>{
 const profile={name:'Research',role:'bot' as const,folder:'/fixture',memoryPath:'.bot/memory.md',job:null};
 const system=desktopPrompts(botPrompts({profile,engine:'agy'}),profile,{command:'fixture --render-report',docs:'/fixture/report-blocks.md'}).system;
 expect(system).not.toContain('Every tool requires a single-action approval card');
 expect(system).toContain('Full permission');
 expect(system).toContain('ReportSpec v2');expect(system).toContain('ASD-STE100');
 for(const resume of [false,true]) {
  const frames:any[]=[];
  const client=new AgyAcpProtocol({command:'unused',cwd:'/fixture',sessionId:'saved',resume,systemPrompt:system},m=>frames.push(m),()=>{},()=>{});
  const started=client.start().catch(()=>{});
  client.receive({jsonrpc:'2.0',id:frames[0].id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{loadSession:true}}});
  for(let i=0;i<15;i++)await Promise.resolve();
  expect(frames[1].method).toBe(resume?'session/load':'session/new');
  expect(frames[1].params._meta.antigravity.systemPrompt.append).toBe(system);
  client.close();await started;
 }
});
