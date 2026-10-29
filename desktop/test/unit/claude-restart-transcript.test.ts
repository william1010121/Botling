import {expect,it} from 'vitest';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {inspectClaudeRestart} from '../../src/core/claude-restart';
import {projectFolderName} from '../../src/core/claude-files';
import {tempDir} from '../helpers';
const session='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(native=false){
 const root=tempDir('claude-restart'),cwd=join(root,'work'),agentId=native?'child-123':undefined;
 const file=join(root,'projects',projectFolderName(cwd),...(agentId?[session,'subagents',`agent-${agentId}.jsonl`]:[session+'.jsonl']));mkdirSync(dirname(file),{recursive:true});
 const row=(type:string,content:any[],stop_reason?:string)=>({type,sessionId:session,...(agentId?{agentId,isSidechain:true}:{}),message:{content,stop_reason}});
 const rows=[row('user',[{type:'text',text:'Research only.'}]),row('assistant',[{type:'tool_use',id:'read-1',name:'Read'}]),row('user',[{type:'tool_result',tool_use_id:'read-1',content:'evidence'}])];
 return {file,rows,row,write:()=>writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n'),check:()=>inspectClaudeRestart({cwd,configDir:root,sessionId:session,agentId,checkpoint:'read-1'})};
}
it.each([false,true])('continues the original session only at a confirmed tool-result boundary (native=%s)',native=>{const f=fixture(native);f.write();expect(f.check()).toEqual({state:'continue'});});
it('uses a final result that arrived after the snapshot without replay',()=>{const f=fixture();f.rows.push(f.row('assistant',[{type:'text',text:'Existing final evidence'}],'end_turn'));f.write();expect(f.check()).toEqual({state:'completed',report:'Existing final evidence'});});
it('blocks pending tools, later prompts, denied tools and missing anchors',()=>{
 for(const mode of ['pending','later','denied','anchor']){const f=fixture();
 if(mode==='pending')f.rows.push(f.row('assistant',[{type:'tool_use',id:'write-2',name:'Write'}]));
 if(mode==='later')f.rows.push(f.row('user',[{type:'text',text:'A different run'}]));
 if(mode==='denied')f.rows[2].message.content[0].is_error=true;
 if(mode==='anchor')f.rows[2].message.content[0].tool_use_id='other';
 f.write();expect(f.check().state).toBe('blocked');}
});
it('does not interpret an ambiguous final assistant message as unfinished work',()=>{const f=fixture(true);f.rows.push(f.row('assistant',[{type:'text',text:'Maybe complete'}]));f.write();expect(f.check().state).toBe('blocked');});
it('refuses foreign identity and truncated transcripts without guessing',()=>{
 const f=fixture(true);f.write();const raw=JSON.parse(readFileSync(f.file,'utf8').split('\n')[0]);raw.agentId='another-agent';writeFileSync(f.file,JSON.stringify(raw)+'\n');expect(f.check().state).toBe('blocked');
 writeFileSync(f.file,'{"type":"assistant"');expect(f.check().state).toBe('blocked');
});
