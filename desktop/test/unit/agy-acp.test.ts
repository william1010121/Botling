import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgyMcpBridge} from '../../src/core/agent/agy-mcp';
import {afterEach,expect,it,vi} from 'vitest';
import {AgyAcpProtocol,AgyAcpHead,ACP_TOOLS,verifyAcpRuntime} from '../../src/core/agent/agy-acp';
const clients:AgyAcpProtocol[]=[];
afterEach(()=>clients.splice(0).forEach(c=>c.close()));
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function harness(resume=false, full=false){
 const frames:any[]=[],items:any[]=[],errors:Error[]=[];
 const client=new AgyAcpProtocol({command:'never-launched',cwd:'/owned',sessionId:'old',resume,bypassPermissions:full},m=>frames.push(m),i=>items.push(i),e=>errors.push(e));clients.push(client);
 const reply=(result:any)=>client.receive({jsonrpc:'2.0',id:frames.findLast(f=>f.method&&f.id).id,result});
 const policy=()=>reply({configOptions:[{id:'mode',currentValue:full?'yolo':'default'}]});
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
 expect(h.items).toContainEqual({kind:'delta',text:'hello'});expect(h.items.some(i=>i.kind==='toolResult'&&i.failed)).toBe(true);expect(h.items.at(-1)).toMatchObject({kind:'result',ok:false,subtype:'permission_denied'});
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
 (head as any).workers={beginReport:()=>true,acknowledgeReport(){},running:[],async close(){}};
 (head as any).protocol={send:async(text:string)=>{sent.push(text);return true;},close(){}};
 (head as any).queue.push({text:'worker report',uuid:'r',images:[],taskId:'task',taskRun:1});
 try{
  await (head as any).drain();expect(sent).toEqual([]);
  head.send('user message','u');await tick();expect(sent).toEqual(['user message']);
  available=true;await vi.advanceTimersByTimeAsync(100);expect(sent).toEqual(['user message','worker report']);
  expect(events.filter(i=>i.kind==='backgroundTurn')).toEqual([{kind:'backgroundTurn',taskId:'task'}]);
 }finally{await head.terminate();vi.useRealTimers();}
});

it('denial and failed tools survive end_turn instead of reporting success',async()=>{
 const h=harness(),done=h.client.send('write','u');await h.init();h.policy();await tick();const id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',id:50,method:'session/request_permission',params:{sessionId:'new',toolCall:{title:'botling_write_file',rawInput:{path:'x'}},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});
 h.client.answer('acp:50',false);
 h.client.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update:{sessionUpdate:'tool_call_update',toolCallId:'t',status:'failed'}}});
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});await done;
 expect(h.items.at(-1)).toMatchObject({kind:'result',ok:false,subtype:'permission_denied'});
});

it('cancel survives end_turn and a subsequent turn starts clean',async()=>{
 const h=harness();let sent=h.client.send('test','one');await h.init();h.policy();await tick();let id=h.frames.at(-1).id;
 h.client.interrupt();h.client.receive({jsonrpc:'2.0',id:400,method:'session/request_permission',params:{sessionId:'new',options:[]}});h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});expect(await sent).toBe(false);expect(h.items.at(-1)).toMatchObject({kind:'result',ok:false,subtype:'cancelled'});
 sent=h.client.send('next','two');await tick();h.policy();await tick();id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});expect(await sent).toBe(true);
});
it('failed tool alone cannot become a successful terminal result',async()=>{
 const h=harness(),sent=h.client.send('test','one');await h.init();h.policy();await tick();const id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update:{sessionUpdate:'tool_call',toolCallId:'failed',status:'failed'}}});
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});expect(await sent).toBe(false);expect(h.items.at(-1)).toMatchObject({ok:false,subtype:'tool_failed'});
});

it('worker entrypoint is blocked before any runtime or profile action',()=>{
 const head=new AgyAcpHead({command:'/never-launched',cwd:'/never-created',sessionId:'old',resume:false,worker:true},{onItem(){},onExit(){}});
 expect(()=>head.start()).toThrow('workers are disabled');expect(head.pid).toBe(-1);
});

it('stale report runs never submit a prompt or open a background turn',async()=>{
 const sent:string[]=[],events:any[]=[];
 const head=new AgyAcpHead({command:'never-spawned',cwd:'/owned',sessionId:'s',resume:false},{onItem:i=>events.push(i),onExit(){}});
 (head as any).protocol={send:async(t:string)=>{sent.push(t);return true;},close(){}};
 (head as any).workers={beginReport:()=>false,async close(){}};
 (head as any).queue.push({text:'stale report',uuid:'r',images:[],taskId:'task',taskRun:1});
 await (head as any).drain();expect(sent).toEqual([]);expect(events.some(e=>e.kind==='backgroundTurn')).toBe(false);await head.terminate();
});
it('failed worker cleanup still attempts parent and tool cleanup and reports failure',async()=>{
 const cleaned:string[]=[];
 const head=new AgyAcpHead({command:'never-spawned',cwd:'/owned',sessionId:'s',resume:false},{onItem(){},onExit(){}});
 (head as any).workers={async close(){cleaned.push('workers');throw Error('fixture failure');}};
 (head as any).bridge={async close(){cleaned.push('tools');}};
 (head as any).process={async terminate(){cleaned.push('parent');return {killed:[],forced:false};}};
 await expect(head.terminate()).rejects.toThrow('cleanup incomplete');expect(cleaned.sort()).toEqual(['parent','tools','workers']);
});

for (const resume of [false,true]) it(`explicit full permission negotiates yolo on ${resume?'resume':'initialize'} and every turn, active only after ACK`,async()=>{
 const h=harness(resume,true);let sent=h.client.send('task','one');expect(h.client.fullPermissionActive).toBe(false);
 await h.init();expect(h.client.fullPermissionActive).toBe(false);h.policy();await tick();expect(h.client.fullPermissionActive).toBe(true);
 expect(h.frames.filter(f=>f.method==='session/set_config_option').map(f=>f.params.value)).toEqual(['yolo','yolo','yolo']);
 const prompt=h.frames.at(-1).id;h.client.receive({jsonrpc:'2.0',id:prompt,result:{stopReason:'end_turn'}});await sent;expect(h.client.fullPermissionActive).toBe(false);
 sent=h.client.send('next','two');await tick();expect(h.client.fullPermissionActive).toBe(false);h.policy();await tick();expect(h.client.fullPermissionActive).toBe(true);
 h.client.interrupt();expect(h.client.fullPermissionActive).toBe(false);h.client.close();await sent;
});
it('full permission rejection never submits or exposes an active capability',async()=>{
 const h=harness(false,true),done=h.client.send('task','one');
 h.reply({protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'}});await tick();h.reply({sessionId:'new'});await tick();
 h.reply({configOptions:[{id:'mode',currentValue:'default'}]});await done;
 expect(h.client.fullPermissionActive).toBe(false);expect(h.errors[0].message).toContain('did not confirm Full permission');expect(h.frames.some(f=>f.method==='session/prompt')).toBe(false);
});
it('runtime mandatory review is not autoanswered in yolo, denial revokes full permission',async()=>{
 const h=harness(false,true),sent=h.client.send('task','one');await h.init();h.policy();await tick();const id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',id:78,method:'session/request_permission',params:{sessionId:'new',toolCall:{title:'administrator review',rawInput:{}},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});
 expect(h.client.fullPermissionActive).toBe(false);expect(h.frames.some(f=>f.id===78)).toBe(false);
 h.client.answer('acp:78',false);expect(h.client.fullPermissionActive).toBe(false);
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});expect(await sent).toBe(false);
});
it('foreign session updates and unexpected mode changes fail closed in full permission',async()=>{
 for(const params of [{sessionId:'foreign',update:{sessionUpdate:'agent_message_chunk'}},{sessionId:'new',update:{sessionUpdate:'current_mode_update',currentModeId:'default'}}]) {
  const h=harness(false,true),sent=h.client.send('task','one');await h.init();h.policy();await tick();
  h.client.receive({jsonrpc:'2.0',method:'session/update',params});await sent;expect(h.errors).toHaveLength(1);expect(h.client.fullPermissionActive).toBe(false);
 }
});

// Replay the T3 research failure: find returned useful output with exit 1,
// then ACP reported a failed tool before the model attempted another read.
it('ordinary tool failure retains negotiated full permission for recovery tools',async()=>{
 const h=harness(false,true),sent=h.client.send('research and create report','one');
 await h.init();h.policy();await tick();const id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update:{sessionUpdate:'tool_call_update',toolCallId:'find',status:'failed',rawOutput:{exitCode:1,output:'/fixture/t3'}}}});
 expect(h.client.fullPermissionActive).toBe(true);
 const dir=mkdtempSync(join(tmpdir(),'agy-recovery-'));
 const bridge=new AgyMcpBridge(dir,dir,undefined,undefined,undefined,()=>h.client.fullPermissionActive);
 try {
  writeFileSync(join(dir,'source.txt'),'research evidence');bridge.beginTurn();
  await expect(bridge.invoke('read_file',{path:'source.txt'})).resolves.toBe('research evidence');
  await expect(bridge.invoke('write_file',{path:'report.json',content:'{}'})).resolves.toBe('File written.');
 } finally {await bridge.close();rmSync(dir,{recursive:true,force:true});}
 h.client.receive({jsonrpc:'2.0',id:79,method:'session/request_permission',params:{sessionId:'new',toolCall:{title:'administrator review'},options:[{kind:'allow_once',optionId:'allow'},{kind:'reject_once',optionId:'deny'}]}});
 expect(h.client.fullPermissionActive).toBe(false);
 h.client.answer('acp:79',false);expect(h.client.fullPermissionActive).toBe(false);
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});expect(await sent).toBe(false);
 expect(h.items.at(-1)).toMatchObject({subtype:'permission_denied'});
});

it('unsupported approval after a failed tool still revokes full permission',async()=>{
 const h=harness(false,true),sent=h.client.send('task','one');await h.init();h.policy();await tick();const id=h.frames.at(-1).id;
 h.client.receive({jsonrpc:'2.0',method:'session/update',params:{sessionId:'new',update:{sessionUpdate:'tool_call',toolCallId:'bad',status:'failed'}}});
 h.client.receive({jsonrpc:'2.0',id:80,method:'session/request_permission',params:{sessionId:'new',options:[]}});
 expect(h.client.fullPermissionActive).toBe(false);
 h.client.receive({jsonrpc:'2.0',id,result:{stopReason:'end_turn'}});await sent;
 expect(h.items.at(-1)).toMatchObject({ok:false,subtype:'permission_denied'});
});
