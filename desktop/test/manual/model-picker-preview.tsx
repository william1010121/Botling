// Isolated acceptance fixture. Uses actual UI and runtime-captured catalogs; it cannot launch engines.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BotSettings } from '../../src/renderer/Settings';
import { RightPanel } from '../../src/renderer/RightPanel';
import type { Client } from '../../src/renderer/client';
import type { BotView } from '../../src/contract';
declare global { interface Window { catalogs:any; previewMode:string; previewCalls:any[]; } }
const bot={id:'preview',name:'Model selection',role:'main',heads:['claude','codex','agy'],phase:'asleep'} as BotView;
let state:any={botId:bot.id,engines:bot.heads,model:'sonnet',subagentModel:'sonnet',codexModel:'gpt-6-astra',agyModel:null,effort:'medium'};
const mode=window.previewMode;
if(mode==='unavailable') state={...state,model:'saved-custom-claude',codexModel:'saved-custom-codex',agyModel:'saved-custom-agy'};
window.previewCalls=[];
const client={request:async(cmd:any)=>{
 window.previewCalls.push(cmd);
 if(cmd.type==='bot.settings')return state;
 if(cmd.type==='bot.configure'){state={...state,...cmd};return state;}
 if(cmd.type==='engine.models'){
  if(mode==='loading')return new Promise(()=>{});
  if(mode==='unavailable')return {status:cmd.engine==='claude'?'unsupported':cmd.engine==='codex'?'error':'signed-out',models:[],source:window.catalogs[cmd.engine].source,message:cmd.engine==='claude'?'This runtime does not report supported models.':cmd.engine==='codex'?'Model discovery timed out. Retry when the engine is available.':'ACP requires sign-in. Sign in through the engine, then retry.'};
  return window.catalogs[cmd.engine];
 }
 throw Error('Unexpected fixture command');
}} as unknown as Client;
createRoot(document.getElementById('root')!).render(createElement(RightPanel,{
 bot,bots:[bot],waiting:{items:[],doing:{}},look:'original',status:{key:'idle',text:'Idle'},results:[],watching:null,tasks:[],messages:[],selectedTask:null,collapsed:false,
 onSelectTask(){},onJumpToTask(){},onAskForReport(){},onCompleteTask(){},onSelect(){},onIgnore(){},onOpenResult(){},onOpenSubagent(){},onUnsettle(){},onSettings(){},onCloseSettings(){},onExpand(){},
 showingSettings:true,settingsPage:createElement(BotSettings,{client,bot}),
}));
