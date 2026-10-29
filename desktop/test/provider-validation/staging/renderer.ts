import {fallbackChoices} from '../../../../Web/src/components';
declare const window:Window & {stage:{snapshot():Promise<any>;start(name:string):Promise<unknown>;choose(id:string,index:number):Promise<unknown>;cancel():Promise<unknown>;onChange(fn:()=>void):void;onError(fn:(message:string)=>void):void}};
const content=document.querySelector('#cards')!,status=document.querySelector('#status')!,error=document.querySelector('#error')!;
const start=document.querySelector('#write') as HTMLButtonElement,cancel=document.querySelector('#cancel') as HTMLButtonElement;
const choice=document.querySelector('#case') as HTMLSelectElement;
let state:any,busy=false;
function controls(){
 start.disabled=!state||busy||state.closed||state.started.length>0;
 choice.disabled=start.disabled;
 cancel.disabled=!state||busy||state.closed;
 start.textContent=busy?'處理中…':state?.safe?'測試介面回應':choice.value==='write'?'開始寫檔驗收':'開始取消驗收';
 document.body.setAttribute('aria-busy',String(busy));
}
async function act(fn:()=>Promise<unknown>,feedback:string){
 if(busy)return;
 busy=true;error.textContent='';status.textContent=feedback;controls();
 try{await fn();await refresh();}
 catch(e){error.textContent=String(e);status.textContent='未執行。請查看下方原因。';}
 finally{busy=false;controls();}
}
// Check the event itself. A capture-phase flag cleared in a microtask expires
// before Chromium delivers the same native event to its target listener.
start.addEventListener('click',event=>{if(event.isTrusted)void act(()=>window.stage.start(choice.value),'正在檢查環境…');});
cancel.addEventListener('click',event=>{if(event.isTrusted)void act(()=>window.stage.cancel(),'正在停止並清理…');});
choice.addEventListener('change',controls);
async function refresh(){
 state=await window.stage.snapshot();
 document.querySelector('#mode')!.textContent=state.safe?'安全預覽 · 不連線、不核准':'隔離驗收 · 正式版未變更';
 document.querySelector('#description')!.textContent=state.safe?'按下按鈕，確認介面能立即回應。此模式不啟動模型。':'寫入一個測試檔案，每個動作仍需你核准。';
 status.textContent=state.closed?'已停止，清理完成。':state.started.length?state.safe?'介面回應正常，未啟動 provider。':'案例已開始，等待正式核准卡。':'準備就緒';
 document.querySelector('#details')!.textContent=`版本 ${state.manifest.commit}\n位置 ${state.workspace}\n測試檔案 ${JSON.stringify(state.marker)}\n開始後最多五分鐘；取消會停止整個隔離案例。`;
 content.replaceChildren();
 for(const message of state.chat.messages){
  const section=document.createElement('section'),text=document.createElement('pre');text.textContent=message.text;section.append(text);
  if(message.approval&&message.choices){
   const identity=document.createElement('small');identity.textContent=`${message.approval.tool} · ${message.id}`;section.append(identity);
   const choices=fallbackChoices(message.choices,message.chosen??null,message.answer??null,state.closed?null:index=>void act(()=>window.stage.choose(message.id,index),'正在提交你的選擇…'));
   // Preserve production card callbacks; reject synthetic clicks on this card
   // before the target handler, without sharing state across event callbacks.
   choices.addEventListener('click',event=>{if(!event.isTrusted||busy)event.stopImmediatePropagation();},true);
   section.append(choices);
  }
  content.append(section);
 }
 controls();
}
async function update(){try{await refresh();}catch(e){error.textContent=`介面未就緒：${String(e)}`;status.textContent='無法連接驗收介面';controls();}}
window.addEventListener('error',event=>{error.textContent=event.message;});
window.addEventListener('unhandledrejection',event=>{error.textContent=String(event.reason);});
if(!window.stage){error.textContent='介面連線失敗：preload bridge 未載入。';status.textContent='無法開始';}
else{window.stage.onChange(()=>void update());window.stage.onError(message=>{error.textContent=message;});void update();}
