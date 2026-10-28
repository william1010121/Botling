import {CodexHead,type CodexHeadConfig,type CodexItem} from './codex';
import type {HeadHandlers} from './head';
import {agyMixedRuntimeEnabled} from './agy-capabilities';
const canonical=(v:any):string=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
/** Staged mixed-mode adapter. Ordinary Codex and its metering implementation stay untouched. */
export class AgyCodexHead extends CodexHead {
  private outcome:{busy:boolean;failure?:string;approvals:Map<string,Record<string,unknown>>};
  constructor(config:CodexHeadConfig,handlers:Omit<HeadHandlers,'onItem'>&{onItem(item:CodexItem):void}){
    if(!agyMixedRuntimeEnabled())throw Error('Mixed Codex runtime is disabled pending live validation.');
    const state={busy:false,failure:undefined as string|undefined,approvals:new Map<string,Record<string,unknown>>()};
    super({...config,autoMode:false,bypassPermissions:false,componentEditor:null,workerInstructions:null,routinesFile:null,writableRoots:[],retryLog:null,
      prefixArgs:[...(config.prefixArgs??[]),'-c','features.multi_agent=false','-c','agents.enabled=false']},
      {...handlers,onItem:item=>{
        if(item.kind==='permission')state.approvals.set(item.requestId,JSON.parse(JSON.stringify(item.input)));
        if(item.kind==='permissionCancelled'&&state.approvals.delete(item.requestId))state.failure??='cancelled';
        if(item.kind==='toolResult'&&item.failed)state.failure??='tool_failed';
        if(item.kind==='result'){
          if(state.approvals.size)state.failure??='unresolved_approval';
          if(state.failure)item={...item,ok:false,error:`Mixed Codex stopped: ${state.failure}`,subtype:state.failure};
          state.busy=false;state.approvals.clear();
        }
        handlers.onItem(item);
      }});
    this.outcome=state;
  }
  override send(text:string,uuid:string,images:string[]=[]){
    if(this.outcome.busy)throw Error('Mixed Codex in-turn input is unsupported; wait or cancel.');
    this.outcome.busy=true;this.outcome.failure=undefined;super.send(text,uuid,images);
  }
  override steer(_text:string):boolean{return false;}
  override answer(id:string,allow:boolean,input:Record<string,unknown>,message?:string){
    const pending=this.outcome.approvals.get(id);if(!pending||canonical(pending)!==canonical(input))return;
    this.outcome.approvals.delete(id);if(!allow)this.outcome.failure='permission_denied';super.answer(id,allow,pending,message);
  }
  override allow(_rules:string[]):never{throw Error('Mixed Codex accepts single-action approvals only.');}
  override interrupt():string{this.outcome.failure??='cancelled';return super.interrupt();}
}
