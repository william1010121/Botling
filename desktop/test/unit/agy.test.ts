import { describe,it,expect } from 'vitest';
import { AgyHead,AgyStream,agyArguments } from '../../src/core/agent/agy';
import { tempDir } from '../helpers';
const config=()=>({command:'agy',cwd:tempDir('agy'),sessionId:'new-session',resume:false});
const wire=(step:object)=>JSON.stringify({event:'step_update',step_update:{conversation_id:'session',step_index:1,...step}});
describe('Antigravity protocol',()=>{
 it('uses its own arguments without permission bypass or Claude flags',()=>{
 expect(agyArguments({...config(),resume:true,sessionId:'prior',model:'model-id',effort:'high'})).toEqual(['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--conversation','prior','--model','model-id','--effort','high']);
 });
 it('streams unicode and maps tools, failure and terminal error',()=>{
 const s=new AgyStream();s.parse(JSON.stringify({event:"init",conversation_id:"session",init:{permission_mode:"request-review"}}));expect(s.parse(wire({step_type:'agent_response',state:'ACTIVE',text_delta:'你好'}))).toContainEqual({kind:'delta',text:'你好'});
 const tool={step_type:'tool',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'printf hello'}}};
 expect(s.parse(wire({...tool,step_index:2,state:'ACTIVE'}))[0]).toMatchObject({kind:'toolUse',tool:'run_command'});
 const done=wire({...tool,step_index:2,state:'DONE',tool_info:{...tool.tool_info,error:{type:'permission',message:'Permission denied'}}});
 expect(s.parse(done)).toEqual([expect.objectContaining({kind:'toolResult',failed:true,output:'Permission denied'})]);expect(s.parse(done)).toEqual([]);
 expect(s.parse(JSON.stringify({event:'result',result:{status:'ERROR',error:'quota exhausted'}})).at(-1)).toMatchObject({kind:'result',ok:false,error:'quota exhausted'});
 });
 it('does not call a soft-denied SUCCESS a completed job',()=>{
 const s=new AgyStream();s.parse(JSON.stringify({event:"init",conversation_id:"session",init:{permission_mode:"request-review"}}));const items=s.parse(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'',denied_actions:[{action:'command',display_name:'RunCommand'}]}}));
 expect(items.at(-1)).toMatchObject({kind:'result',ok:false});expect(JSON.stringify(items)).toContain('RunCommand');
 expect(items.some(i=>i.kind==='permission')).toBe(false);
 });
 it('cannot manufacture approval or send any text while blocked',()=>{
 const head=new AgyHead(config(),{onItem(){},onExit(){}});
 expect(()=>head.send('hello','id')).toThrow('pre-task policy barrier');
 expect(()=>head.answer('request',true,{})).toThrow('cannot receive approval');expect(()=>head.allow(['command(*)'])).toThrow('cannot be changed');
 expect(()=>head.send('image','id',['x.png'])).toThrow('text only');
 });
});
