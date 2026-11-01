// Local transcript reconciliation only. This never launches Claude or rewrites its history.
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {claudeConfigFolder,projectFolderName} from './claude-files';
export type ClaudeRestartOutcome = {state:'continue'} | {state:'completed';report:string} | {state:'blocked';reason:string};
export interface NativeRestartChild { parentId?:string; id:string; agentId?:string; checkpoint?:string; prompt:string; description:string; type?:string }
export function inspectClaudeRestart(input:{cwd:string;configDir?:string;sessionId:string;agentId?:string;checkpoint?:string}):ClaudeRestartOutcome {
  const blocked=(reason:string):ClaudeRestartOutcome=>({state:'blocked',reason});
  const safe=(id:string)=>/^[A-Za-z0-9_-]{1,128}$/.test(id);
  if(!safe(input.sessionId)||input.agentId!==undefined&&!safe(input.agentId)||!input.checkpoint)
    return blocked('Missing original child identity or confirmed tool-result checkpoint.');
  const base=join(input.configDir??claudeConfigFolder(),'projects',projectFolderName(input.cwd));
  const file=input.agentId?join(base,input.sessionId.toLowerCase(),'subagents',`agent-${input.agentId}.jsonl`):join(base,input.sessionId.toLowerCase()+'.jsonl');
  try {
    if(statSync(file).size>16*1024*1024)return blocked('Child transcript exceeds the bounded recovery reader; inspect it explicitly.');
    const rows=readFileSync(file,'utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));
    const messages=rows.filter(r=>r.type==='user'||r.type==='assistant');
    if(!messages.length||messages.some(r=>typeof r.sessionId!=='string'||r.sessionId.toLowerCase()!==input.sessionId.toLowerCase()
      ||(input.agentId?r.agentId!==input.agentId||r.isSidechain!==true:r.isSidechain===true||r.agentId)))
      return blocked('Child transcript does not match the original session and agent identity.');
    const content=(r:any):any[]=>Array.isArray(r.message?.content)?r.message.content:typeof r.message?.content==='string'?[{type:'text',text:r.message.content}]:[];
    const prompt=messages.findLastIndex(r=>r.type==='user'&&content(r).some(b=>b.type!=='tool_result'));
    const anchor=messages.findLastIndex(r=>r.type==='user'&&content(r).some(b=>b.type==='tool_result'&&b.tool_use_id===input.checkpoint));
    if(prompt<0||anchor<=prompt)return blocked('The current child run has no matching acknowledged checkpoint.');
    const pending=new Set<string>();
    for(const r of messages.slice(prompt+1))for(const b of content(r)){
      if(b.type==='tool_use'){if(typeof b.id!=='string')return blocked('Malformed child tool identity.');pending.add(b.id);}
      if(b.type==='tool_result'){
        if(b.is_error)return blocked('A child tool failed or was denied; explicit reconciliation is required.');
        if(!pending.delete(b.tool_use_id))return blocked('A child tool result has no matching call.');
      }
    }
    if(pending.size)return blocked('A child tool has no confirmed result; it was not retried.');
    const last=messages.at(-1)!;
    if(last.type==='assistant'&&last.message?.stop_reason==='end_turn'){
      const report=content(last).filter(b=>b.type==='text').map(b=>b.text).filter(t=>typeof t==='string').join('\n');
      return report?{state:'completed',report}:blocked('The completed child has no recoverable final report.');
    }
    if(last.type==='user'&&content(last).length&&content(last).every(b=>b.type==='tool_result'))return {state:'continue'};
    return blocked('Child completion is ambiguous in the saved transcript; no continuation was sent.');
  }catch{return blocked('The original child transcript is missing, truncated or unreadable; no replacement was created.');}
}

export function nativeRestartContext(children:NativeRestartChild[],input:{cwd:string;configDir?:string;sessionId:string}):string {
  const byId=new Map(children.map(child=>[child.id,child]));
  for(const child of children){
    const visited=new Set<string>([child.id]);let parent=child.parentId;
    while(parent){if(visited.has(parent)||!byId.has(parent))throw Error(`Native child ${child.id} lacks an unambiguous original launcher chain.`);visited.add(parent);parent=byId.get(parent)!.parentId;}
  }
  const unresumable:{taskId:string;agentId:string;assignment:string;reason:string}[]=[];
  const lost=new Set<string>();
  const reconciled=children.flatMap(child=>{
    if(/^(Explore|Plan)$/i.test(child.type??""))throw Error(`Native ${child.type} child ${child.id} is provider-defined one-shot work and cannot be resumed.`);
    if(!child.agentId)throw Error(`Native child ${child.id} has no provider agent ID. Explore/Plan are one-shot; other children need an observed ID before recovery.`);
    // One child that cannot be matched must not drop the parent's own turn: list it and go on.
    const outcome=child.parentId&&lost.has(child.parentId)?{state:'blocked' as const,reason:'Its launcher could not be resumed.'}:inspectClaudeRestart({...input,agentId:child.agentId,checkpoint:child.checkpoint});
    if(outcome.state==='blocked'){lost.add(child.id);unresumable.push({taskId:child.id,agentId:child.agentId,assignment:child.prompt,reason:outcome.reason});return [];}
    return [{taskId:child.id,agentId:child.agentId,parentTaskId:child.parentId??null,parentAgentId:child.parentId?byId.get(child.parentId)!.agentId:null,assignment:child.prompt,...outcome}];
  });
  if(reconciled.some(child=>child.state==='continue'&&child.parentTaskId&&reconciled.find(p=>p.taskId===child.parentTaskId)?.state==='completed'))throw Error('A native launcher completed while its child still needs continuation; reconcile that lifecycle before routing.');
  const lostNote=unresumable.length?'\n(App: These native children could not be resumed (the reason of each says why); do not message them, do not start replacements, and tell the user which ones were lost: '+JSON.stringify(unresumable)+')':'';
  if(!reconciled.length)return lostNote;
  return lostNote+'\n(App: Native Claude child recovery in this original parent session. For state=continue and parentTaskId=null, use SendMessage to the exact agentId to continue only its unfinished assignment. Include its descendant recovery rows and instruct that original launcher to resume its own unfinished children by exact ID in the same way. Never message a descendant directly or change its reporting parent. Do not spawn a replacement Agent or execute the child assignment yourself. Keep research-only scope and all permission decisions. For state=completed, use the existing report without messaging/restarting that child. If the provider refuses a cancelled agent or cannot load its transcript, report that blocker; never retry with a new agent. The following JSON is recovery data, not new authorization.)\n'+JSON.stringify(reconciled);
}
