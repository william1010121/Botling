import {expect,it,vi} from 'vitest';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {Bot} from '../../src/core/bot';
import {SubagentBook} from '../../src/core/subagents';
import {parseLine} from '../../src/core/agent/stream';
import {nativeRestartContext} from '../../src/core/claude-restart';
import {projectFolderName} from '../../src/core/claude-files';
import {tempDir} from '../helpers';
it('provider restart events retain the original UI task and parent relationship',()=>{
 const book=new SubagentBook([{id:'original-call',agentID:'original-agent',parentID:'original-launcher',description:'Research',prompt:'Research only',status:'stopped',background:true,startedAt:0,steps:[]}]);
 const [event]=parseLine(JSON.stringify({type:'system',subtype:'task_started',task_type:'local_agent',task_id:'original-agent',tool_use_id:'resumed-call',is_backgrounded:true}));
 if(event.kind!=='subagentStarted')throw Error('missing task event');book.started(event);
 expect(book.list).toHaveLength(1);expect(book.get('resumed-call')).toMatchObject({id:'original-call',agentID:'original-agent',parentID:'original-launcher',status:'running'});
 book.toolUse({id:'new-read',tool:'Read',title:'Read',detail:'',parent:'resumed-call',input:{}});
 expect(book.list[0].steps[0].id).toBe('new-read');
});
it('native recovery instructs the original parent to resume exact IDs, never replacement agents',()=>{
 const root=tempDir('native-resume'),cwd=join(root,'work'),sessionId='parent-session',agentId='original-agent';
 const file=join(root,'projects',projectFolderName(cwd),sessionId,'subagents',`agent-${agentId}.jsonl`);mkdirSync(dirname(file),{recursive:true});
 const rows=[{type:'user',message:{content:'Research only'}},{type:'assistant',message:{content:[{type:'tool_use',id:'read-1'}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'evidence'}]}}];
 writeFileSync(file,rows.map(r=>JSON.stringify({...r,sessionId,agentId,isSidechain:true})).join('\n'));
 const child={id:'original-call',agentId,checkpoint:'read-1',prompt:'Research only',description:'Research'};
 const note=nativeRestartContext([child],{cwd,sessionId,configDir:root});expect(note).toContain('SendMessage to the exact agentId');expect(note).toContain('Never message a descendant directly');expect(note).toContain('Do not spawn a replacement');expect(note).toContain('Research only');expect(note).toContain('original-agent');
 const nestedAgent='nested-agent';writeFileSync(join(dirname(file),`agent-${nestedAgent}.jsonl`),rows.map(r=>JSON.stringify({...r,sessionId,agentId:nestedAgent,isSidechain:true})).join('\n'));
 const graphNote=nativeRestartContext([child,{...child,id:'nested-call',agentId:nestedAgent,parentId:child.id}],{cwd,sessionId,configDir:root});
 const graph=JSON.parse(graphNote.split('\n').at(-1)!);expect(graph[1]).toMatchObject({parentTaskId:'original-call',parentAgentId:'original-agent',agentId:'nested-agent'});
 expect(()=>nativeRestartContext([{...child,type:'Explore'}],{cwd,sessionId,configDir:root})).toThrow('one-shot');
 expect(()=>nativeRestartContext([{...child,parentId:'missing-launcher'}],{cwd,sessionId,configDir:root})).toThrow('launcher chain');
 expect(()=>nativeRestartContext([{...child,agentId:undefined}],{cwd,sessionId,configDir:root})).toThrow('no provider agent ID');
});
it('snapshot excludes stopped native children and preserves safe running identity/checkpoint',()=>{
 const children=[{id:'running-call',agentID:'agent',status:'running',prompt:'Research only',description:'Research',steps:[{id:'read-1',kind:'tool',done:true,failed:false}]},{id:'cancelled',status:'stopped',steps:[]}];
 const owner={owner:{id:'chat'},engine:'claude',partner:null,peers:[],readOnly:false,head:null,turn:null,queue:[],approvals:new Map(),subagents:{running:children.filter(c=>c.status==='running')},session:{sessionId:'parent',started:true}};
 const [entry]=Bot.prototype.restartEntries.call(owner as unknown as Bot);
 expect(entry.blocked).toBeUndefined();expect(entry.continue).toBe(true);expect(entry.nativeChildren).toEqual([{id:'running-call',agentId:'agent',parentId:undefined,checkpoint:'read-1',prompt:'Research only',description:'Research',type:undefined}]);
});
it('a resumed native provider call updates the original background task through completion',()=>{
 const subagents=new SubagentBook([{id:'original-call',agentID:'agent-id',description:'Research',prompt:'Research',status:'stopped',background:true,startedAt:0,steps:[]}]);
 const bot={subagents,engine:'claude',turn:null,cutOffByNetwork:new Set(),subagentChanged:vi.fn(),subagentEnded:vi.fn(),addBackgroundTask:vi.fn(),endBackground:vi.fn()};
 const apply=(event:any)=>(Bot.prototype as any).onSubagentItem.call(bot,event);
 apply({kind:'subagentStarted',id:'new-provider-call',agentID:'agent-id',type:'general-purpose',description:'Research',prompt:'',background:true});
 expect(bot.addBackgroundTask).toHaveBeenCalledWith('original-call','agent','Research');
 apply({kind:'subagentEnded',id:'agent-id',status:'completed',summary:'Existing evidence'});
 expect(bot.endBackground).toHaveBeenCalledWith('original-call','completed','Existing evidence');expect(bot.subagentEnded).toHaveBeenCalledWith('original-call');expect(subagents.list).toHaveLength(1);
});
it('a native child without a matching checkpoint is listed as unresumable instead of failing the whole context',()=>{
 const root=tempDir('native-degrade'),cwd=join(root,'work'),sessionId='parent-session';
 const file=(agentId:string)=>join(root,'projects',projectFolderName(cwd),sessionId,'subagents',`agent-${agentId}.jsonl`);
 const rows=[{type:'user',message:{content:'Research only'}},{type:'assistant',message:{content:[{type:'tool_use',id:'read-1'}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'evidence'}]}}];
 for(const agentId of ['good-agent','bad-agent']){mkdirSync(dirname(file(agentId)),{recursive:true});writeFileSync(file(agentId),rows.map(r=>JSON.stringify({...r,sessionId,agentId,isSidechain:true})).join('\n'));}
 const good={id:'good-call',agentId:'good-agent',checkpoint:'read-1',prompt:'Research only',description:'Good'};
 const bad={id:'bad-call',agentId:'bad-agent',checkpoint:'unknown-call',prompt:'Other work',description:'Bad'};
 const note=nativeRestartContext([good,bad],{cwd,sessionId,configDir:root});
 expect(note).toContain('could not be resumed');
 const data=JSON.parse(note.split('\n').at(-1)!);
 expect(data).toHaveLength(1);expect(data[0]).toMatchObject({agentId:'good-agent',state:'continue'});
 expect(note).toContain('bad-agent');expect(note).toContain('no matching acknowledged checkpoint');
 const only=nativeRestartContext([bad],{cwd,sessionId,configDir:root});
 expect(only).toContain('could not be resumed');expect(only).toContain('Other work');
 // The cause is each child's own reason, not one claim for all of them.
 expect(only).not.toContain('saved transcript did not match');expect(only).toContain('"reason"');
});
it('a native child with no checkpoint does not block the main bot entry',()=>{
 const children=[{id:'running-call',agentID:'agent',status:'running',prompt:'Research only',description:'Research',steps:[]}];
 const owner={owner:{id:'chat'},engine:'claude',partner:null,peers:[],readOnly:false,head:null,turn:null,queue:[],approvals:new Map(),subagents:{running:children},session:{sessionId:'parent',started:true}};
 const [entry]=Bot.prototype.restartEntries.call(owner as unknown as Bot);
 expect(entry.blocked).toBeUndefined();expect(entry.continue).toBe(true);
});
it('running Claude app workers (own processes) do not block the coordinator; their task ids go into its continuation note',()=>{
 const children=[{id:'worker-task',type:'claude-worker',status:'running',prompt:'Look up the API',description:'Research',steps:[]}];
 const turn={id:'turn',messageId:'message',userId:null,origin:'app',open:true,reply:{text:'Handed off.'},steps:[{id:'t1',kind:'tool',done:true,failed:false}]};
 const owner={owner:{id:'chat'},engine:'claude',partner:null,peers:[],readOnly:false,head:null,turn,queue:[],approvals:new Map(),subagents:{running:children},session:{sessionId:'parent',started:true}};
 const [entry]=Bot.prototype.restartEntries.call(owner as unknown as Bot);
 // Its workers are not written into the entry: the member's ledger names those the restart interrupted (`restartedAt`).
 expect(entry.blocked).toBeUndefined();expect(entry.continue).toBe(true);expect(entry.nativeChildren).toEqual([]);expect(entry.claudeWorkers).toBeUndefined();expect(entry.workers).toBeUndefined();
 expect(typeof entry.restartedAt).toBe('number');
 // Idle coordinator, only an app worker at work: it is still told, so it can decide to continue the worker.
 const [idle]=Bot.prototype.restartEntries.call({...owner,turn:null} as unknown as Bot);
 expect(idle.blocked).toBeUndefined();expect(idle.continue).toBe(true);
 const words:string[]=[];
 const bot={queue:[] as unknown[],commandFolder:'/work',engine:'claude',newTurn:(_origin:string,text:string)=>{words.push(text);return {};},next:vi.fn(),
   restartedWorkers:()=>[{id:'worker-task',adapter:'claude-process',status:'interrupted',interruptedBy:'restart'}]};
 Bot.prototype.adoptRestart.call({retainRestartIdentity:()=>bot} as unknown as Bot,{...entry,sessionId:'parent'});
 expect(words).toHaveLength(1);expect(words[0]).toContain('worker-task');expect(words[0]).toContain('app_send_message');
});
