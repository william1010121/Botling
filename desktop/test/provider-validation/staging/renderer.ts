import {fallbackChoices} from '../../../../Web/src/components';
declare const window:Window & {stage:{snapshot():Promise<any>;start(name:string):Promise<unknown>;choose(id:string,index:number):Promise<unknown>;cancel():Promise<unknown>;onChange(fn:()=>void):void;onError(fn:(message:string)=>void):void}};
const content=document.querySelector('#cards')!,status=document.querySelector('#status')!,error=document.querySelector('#error')!;
let trustedClick=false;
document.addEventListener('click',event=>{trustedClick=event.isTrusted;queueMicrotask(()=>{trustedClick=false;});},true);
const act=(fn:()=>Promise<unknown>)=>{if(!trustedClick)return;void fn().then(refresh).catch(e=>{error.textContent=String(e);});};
for(const name of ['write','command'])document.querySelector('#'+name)!.addEventListener('click',()=>act(()=>window.stage.start(name)));
document.querySelector('#cancel')!.addEventListener('click',()=>act(()=>window.stage.cancel()));
async function refresh(){
 const state=await window.stage.snapshot();status.textContent=`Candidate ${state.manifest.commit}\nScratch: ${state.workspace}\nMarker: ${JSON.stringify(state.marker)}\n${state.closed?'Run closed. Start a fresh runner for another case.':'No action is approved automatically.'}`;
 content.replaceChildren();
 for(const message of state.chat.messages){
  const section=document.createElement('section'),text=document.createElement('pre');text.textContent=message.text;section.append(text);
  if(message.approval&&message.choices){
   const identity=document.createElement('code');identity.textContent=`Official approval ${message.id} · ${message.approval.tool} · expires ${message.approval.expires}`;section.append(identity);
   section.append(fallbackChoices(message.choices,message.chosen??null,message.answer??null,state.closed?null:index=>act(()=>window.stage.choose(message.id,index))));
  }
  content.append(section);
 }
 for(const name of ['write','command'])(document.querySelector('#'+name) as HTMLButtonElement).disabled=state.closed||state.started.length>0;
}
window.stage.onChange(()=>void refresh());window.stage.onError(message=>{error.textContent=message;});void refresh();
