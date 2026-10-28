import {afterEach,expect,it,vi} from 'vitest';
import {AgyAcpProtocol,AgyAcpHead,ACP_TOOLS,verifyAcpRuntime} from '../../src/core/agent/agy-acp';
const clients:AgyAcpProtocol[]=[];
afterEach(()=>clients.splice(0).forEach(c=>c.close()));
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function harness(resume=false){
 const frames:any[]=[],items:any[]=[],errors:Error[]=[];
 const client=new AgyAcpProtocol({command:'never-launched',cwd:'/owned',sessionId:'old',resume},m=>frames.push(m),i=>items.push(i),e=>errors.push(e));clients.push(client);
 const reply=(result:any)=>client.receive({jsonrpc:'2.0',id:frames.findLast(f=>f.method&&f.id).id,result});
 const policy=()=>reply({configOptions:[{id:'mode',currentValue:'default'}]});
 const init=async()=>{reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{loadSession:true}});await tick();reply({sessionId:resume?'old':'new'});await tick();policy();await tick();policy();await tick();};
 return {client,frames,items,errors,reply,policy,init};
}
it('never submits task before policy ACK; yolo fails closed',async()=>{
 const h=harness(),done=h.client.send('task','u');expect(h.frames.map(f=>f.method)).toEqual(['initialize']);
 h.reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'}});await tick();
 expect(h.frames.at(-1).params._meta.antigravity.enabledTools).toEqual(ACP_TOOLS);
 h.reply({sessionId:'new'});await tick();h.reply({configOptions:[{id:'mode',currentValue:'yolo'}]});await done;
 expect(h.errors).toHaveLength(1);expect(h.frames.some(f=>f.method==='session/prompt')).toBe(false);expect(h.items.some(i=>i.kind==='init')).toBe(false);
});
it('premature success fails the state machine without sending task',async()=>{
 const h=harness(),done=h.client.send('task','u');h.client.receive({jsonrpc:'2.0',id:999,result:{stopReason:'end_turn'}});await done;
 expect(h.errors).toHaveLength(1);expect(h.frames.some(f=>f.method==='session/prompt')).toBe(false);
});
it('failed resume does not create replacement conversation or expose auth error details',async()=>{
 const h=harness(true),done=h.client.send('task','u');h.reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{loadSession:true}});await tick();
 expect(h.frames.at(-1)).toMatchObject({method:'session/load',params:{sessionId:'old'}});
 h.client.receive({jsonrpc:'2.0',id:h.frames.at(-1).id,error:{code:-32000,message:'secret-code'}});await done;
 expect(h.errors[0]?.message).not.toContain('secret');expect(h.frames.some(f=>f.method==='session/new')).toBe(false);
});
it('streams tools/text, holds approval, rejects once and cancels pending cards',async()=>{
 const h=harness(),done=h.client.send('task','u');await h.init();h.policy();await tick();expect(h.frames.at(-1).method).toBe('session/prompt');const prompt=h.frames.at(-1).id;
 const update=(u:any)=>h.client.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update:u}});
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'hello'}});
 update({sessionUpdate:'tool_call',toolCallId:'t',title:'write',kind:'edit',rawInput:{path:'a'},status:'pending'});
 const ask=(id:number,allow='allow')=>h.client.receive({jsonrpc:'2.0',method:'session/request_permission',id,params:{sessionId:'new',toolCall:{toolCallId:'t',title:'write',rawInput:{path:'a'}},options:[{kind:'allow_once',optionId:allow},{kind:'reject_once',optionId:'deny'},{kind:'allow_always',optionId:'always'}]}});
 ask(100);expect(h.frames.some(f=>f.id===100)).toBe(false);h.client.answer('acp:100',false);expect(h.frames.at(-1).result.outcome.optionId).toBe('deny');
 ask(101);h.client.interrupt();expect(h.frames.at(-1).result.outcome.outcome).toBe('cancelled');h.client.answer('acp:101',true);expect(h.frames.some(f=>f.result?.outcome?.optionId==='allow')).toBe(false);
 ask(102,'trust');expect(h.frames.at(-1).result.outcome.outcome).toBe('cancelled');
 update({sessionUpdate:'tool_call_update',toolCallId:'t',status:'failed',rawOutput:'refused'});
 h.client.receive({jsonrpc:'2.0',id:prompt,result:{stopReason:'cancelled'}});await done;
 expect(h.items).toContainEqual({kind:'delta',text:'hello'});expect(h.items.some(i=>i.kind==='toolResult'&&i.failed)).toBe(true);expect(h.items.at(-1)).toMatchObject({kind:'result',ok:false,subtype:'cancelled'});
});
it('close during handshake prevents later task submission',async()=>{
 const h=harness(),done=h.client.send('task','u');h.client.close();await done;expect(h.frames.map(f=>f.method)).toEqual(['initialize']);
});
it('never accepts legacy executable or native delegation inventory',()=>{
 expect(()=>verifyAcpRuntime('agy')).toThrow('Verified ACP');expect(ACP_TOOLS).not.toContain('invoke_subagent');expect(ACP_TOOLS).not.toContain('run_workflow');
});

it('interrupt while awaiting startup acknowledgements cannot release a queued task',async()=>{
 const h=harness(),done=h.client.send('task','u');h.client.interrupt();await h.init();h.policy();await done;
 expect(h.frames.some(f=>f.method==='session/prompt')).toBe(false);
});

it('worker reports wait for the Bot scheduler and cannot consume a queued user turn',async()=>{
 vi.useFakeTimers();let available=false;const sent:string[]=[],events:any[]=[];
 const head=new AgyAcpHead({command:'never-spawned',cwd:'/owned',sessionId:'s',resume:false,canStartReport:()=>available},{onItem:i=>events.push(i),onExit(){}});
 (head as any).protocol={send:async(text:string)=>{sent.push(text);return true;},close(){}};
 (head as any).queue.push({text:'worker report',uuid:'r',images:[],taskId:'task',taskRun:1});
 try{
  await (head as any).drain();expect(sent).toEqual([]);
  head.send('user message','u');await tick();expect(sent).toEqual(['user message']);
  available=true;await vi.advanceTimersByTimeAsync(100);expect(sent).toEqual(['user message','worker report']);
  expect(events.filter(i=>i.kind==='backgroundTurn')).toEqual([{kind:'backgroundTurn',taskId:'task'}]);
 }finally{await head.terminate();vi.useRealTimers();}
});
