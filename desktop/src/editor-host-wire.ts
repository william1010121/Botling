// Native-editor transport. Never a core-command or editing-event bridge.
import {FILE_DATA_LIMIT} from './contract/editor-card';
export const EDITOR_URL='botling-chat://chat/chat.html?nativeHost=1';
export const EDITOR_ARGUMENT='--botling-editor-host=1';
export const EDITOR_CHANNEL={up:'botling:editor:up',down:'botling:editor:down',bound:'botling:editor:bound',unbound:'botling:editor:unbound',shell:'botling:editor:shell',layout:'botling:editor:layout',snapshot:'botling:editor:snapshot',
 /** A file dropped on the chat, by the path the editor's preload read from the File itself (never a page string). */
 drop:'botling:editor:drop'} as const;
export interface EditorStamp {surfaceId:string;documentGeneration:string}
export interface EditorPacket {stamp:EditorStamp;message:unknown}
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function isEditorStamp(v:unknown):v is EditorStamp {return object(v)&&Object.keys(v).length===2&&['surfaceId','documentGeneration'].every(k=>typeof v[k]==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(v[k]));}
export function editorPreloadAllowed(mainFrame:boolean,url:string,argv:string[]):boolean {return mainFrame&&url===EDITOR_URL&&argv.includes(EDITOR_ARGUMENT);}
function bounded(value:unknown,limit:number):boolean {try{const text=JSON.stringify(value);return typeof text==='string'&&new TextEncoder().encode(text).length<=limit;}catch{return false;}}
/** A pasted or dropped file the page read (`addFileData`): its base64 may be up to the contract's
 * FILE_DATA_LIMIT (a screenshot is megabytes), so it is checked on its own and the rest of the
 * message still has the 1 MB cap. Anything else shaped differently is not file data. */
function fileData(value:Record<string,any>):Record<string,any>|null {
 const action=value.action;
 if(value.botling!=='action'||!object(action)||action.type!=='addFileData')return null;
 if(Object.keys(action).some(key=>!['type','name','base64','botID','requestID'].includes(key))||typeof action.name!=='string'||action.name.length<1||action.name.length>255)return null;
 if(action.botID!==undefined&&(typeof action.botID!=='string'||action.botID.length<1||action.botID.length>160))return null;
 if(action.requestID!==undefined&&(typeof action.requestID!=='string'||action.requestID.length<1||action.requestID.length>80))return null;
 const base64=action.base64;
 if(typeof base64!=='string'||base64.length<1||base64.length>FILE_DATA_LIMIT||!/^[A-Za-z0-9+/=]+$/.test(base64))return null;
 return {...value,action:{...action,base64:''}};
}
export function editorMessageAllowed(direction:'up'|'down',value:unknown):boolean {
 if(!object(value))return false;
 const file=direction==='up'?fileData(value):null;
 if(!bounded(file??value,direction==='up'?1024*1024:16*1024*1024))return false;
 if(direction==='down'&&value.botling==='composerModelsResult') {
  if(!Number.isSafeInteger(value.requestID)||value.requestID<1||Object.keys(value).some(key=>!['botling','requestID','value','error'].includes(key)))return false;
  if(value.error!==undefined)return typeof value.error==='string'&&value.error.length<=4096&&value.value===undefined;
  const result=value.value;if(!object(result))return false;
  if(Array.isArray(result.models))return ['ready','signed-out','unsupported','unavailable','error'].includes(result.status)&&typeof result.message==='string'&&result.models.length<=500&&result.models.every((m:unknown)=>object(m)&&typeof m.id==='string'&&typeof m.name==='string'&&typeof m.isDefault==='boolean'&&(m.efforts===null||Array.isArray(m.efforts)&&m.efforts.every((e:unknown)=>typeof e==='string')));
  return typeof result.botId==='string'&&Array.isArray(result.engines)&&result.engines.every((e:unknown)=>['claude','codex','agy'].includes(String(e)))&&['model','codexModel','agyModel','effort'].every(key=>result[key]===null||typeof result[key]==='string');
 }
 if(direction==='down'&&value.botling==='projectFilesResult') {
  if(!Number.isSafeInteger(value.requestID)||value.requestID<1||Object.keys(value).some(key=>!['botling','requestID','value','error'].includes(key)))return false;
  if(value.error!==undefined)return typeof value.error==='string'&&value.error.length<=4096&&value.value===undefined;
  const result=value.value;if(!object(result))return false;
  if(Array.isArray(result.files))return result.files.length<=40&&typeof result.limited==='boolean'&&result.files.every((file:unknown)=>object(file)&&typeof file.path==='string'&&file.path.length<=4096&&typeof file.url==='string'&&file.url.startsWith('file:')&&file.url.length<=16384);
  return typeof result.text==='string'&&result.text.length<=32768&&['text','truncated','binary','unavailable'].includes(result.status);
 }
 if(direction==='down'&&value.botling==='composerResult')return Object.keys(value).every(key=>['botling','requestID','ok','error'].includes(key))&&typeof value.requestID==='string'&&value.requestID.length>0&&value.requestID.length<=80&&typeof value.ok==='boolean'&&(value.error===undefined||typeof value.error==='string'&&value.error.length<=4096);
 // A plugin's composerBar view (chat-frame/composer-bar.ts): down, which view and its two card pages, and replies to its frames;
 // up, the page asking for it again and what its frames posted (the shell checks those as any plugin frame's).
 const barFrame=(v:unknown)=>v==='compact'||v==='expanded';
 const keys=(v:Record<string,any>,allowed:string[])=>Object.keys(v).every(key=>allowed.includes(key));
 if(direction==='down'&&value.botling==='composerBar'){
  const bar=value.bar;if(!keys(value,['botling','bar']))return false;if(bar===null)return true;
  return object(bar)&&keys(bar,['plugin','view','title','width','compact','expanded'])&&['plugin','view','title'].every(key=>typeof bar[key]==='string'&&bar[key].length<=200)
   &&Number.isInteger(bar.width)&&bar.width>=80&&bar.width<=480&&['compact','expanded'].every(key=>typeof bar[key]==='string'&&bar[key].startsWith('botling-card://page/')&&bar[key].length<=200);
 }
 if(direction==='down'&&value.botling==='composerBarReply')return keys(value,['botling','frame','data'])&&barFrame(value.frame);
 if(direction==='up'&&value.botling==='composerBarAsk')return keys(value,['botling']);
 if(direction==='up'&&value.botling==='composerBarFrame')return keys(value,['botling','frame','data'])&&barFrame(value.frame);
 // A plugin command a web part in the chat page registered, run from the app page (a key, menu or the palette: App.tsx runPluginCommand).
 if(direction==='down'&&value.botling==='runCommand')return keys(value,['botling','id'])&&typeof value.id==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value.id);
 // How the app page's ApprovalSheet ended for a web part's ask (botling.board's pin commands: App.tsx approvalRequest).
 if(direction==='down'&&value.botling==='approvalReply')return keys(value,['botling','requestId','allowed'])&&Number.isSafeInteger(value.requestId)&&value.requestId>=0&&typeof value.allowed==='boolean';
 if(direction==='down')return ['widthRejected','widthPreview','shortcuts','state','stateDelta','answerWithSaved','page','plugins','hostReply','taskOutput','detailReply','messageWidthPointer','spec','focus'].includes(value.botling);
 switch(value.botling){
  case 'action':return object(value.action)&&typeof value.action.type==='string'&&value.action.type.length<=80&&!['keydown','keyup','keypress','insertText','editReplay'].includes(value.action.type);
  case 'stop':return true;
  case 'messageWidth':return value.value===null||typeof value.value==='number'&&Number.isFinite(value.value);
  case 'messageWidthDrag':return typeof value.active==='boolean';
  case 'page':return Number.isSafeInteger(value.id)&&value.id>=0&&typeof value.html==='string'&&value.html.length<=200_000;
  case 'hostObservation':return (value.chatId===null||typeof value.chatId==='string'&&value.chatId.length<=160)&&Number.isSafeInteger(value.intentEpoch)&&value.intentEpoch>=0&&Number.isSafeInteger(value.revision)&&value.revision>=0;
  default:return false;
 }
}
export function isEditorPacket(direction:'up'|'down',v:unknown):v is EditorPacket {return object(v)&&Object.keys(v).length===2&&isEditorStamp(v.stamp)&&editorMessageAllowed(direction,v.message);}
