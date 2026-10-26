// Native-editor transport. Never a core-command or editing-event bridge.
import {Command,FILE_DATA_LIMIT} from './contract';
export const EDITOR_URL='botling-chat://chat/chat.html?nativeHost=1';
export const EDITOR_ARGUMENT='--botling-editor-host=1';
export const EDITOR_CHANNEL={up:'botling:editor:up',down:'botling:editor:down',bound:'botling:editor:bound',unbound:'botling:editor:unbound',shell:'botling:editor:shell',layout:'botling:editor:layout',snapshot:'botling:editor:snapshot'} as const;
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
 if(Object.keys(action).length!==3||typeof action.name!=='string'||action.name.length<1||action.name.length>255)return null;
 const base64=action.base64;
 if(typeof base64!=='string'||base64.length<1||base64.length>FILE_DATA_LIMIT||!/^[A-Za-z0-9+/=]+$/.test(base64))return null;
 return {...value,action:{...action,base64:''}};
}
export function editorMessageAllowed(direction:'up'|'down',value:unknown):boolean {
 if(!object(value))return false;
 const file=direction==='up'?fileData(value):null;
 if(!bounded(file??value,direction==='up'?1024*1024:16*1024*1024))return false;
 if(direction==='down')return ['widthRejected','widthPreview','state','response','answerWithSaved','page','plugins','hostReply','taskOutput','detailReply','messageWidthPointer','jumpToTask','spec','focus'].includes(value.botling);
 switch(value.botling){
  case 'action':return object(value.action)&&typeof value.action.type==='string'&&value.action.type.length<=80&&!['keydown','keyup','keypress','insertText','editReplay'].includes(value.action.type);
  case 'request':{const parsed=Command.safeParse(value.cmd);return Number.isSafeInteger(value.id)&&value.id>=0&&parsed.success&&['card.save','card.action'].includes(parsed.data.type);}
  case 'stop':return true;
  case 'messageWidth':return value.value===null||typeof value.value==='number'&&Number.isFinite(value.value);
  case 'messageWidthDrag':return typeof value.active==='boolean';
  case 'page':return Number.isSafeInteger(value.id)&&value.id>=0&&typeof value.html==='string'&&value.html.length<=200_000;
  case 'hostObservation':return (value.chatId===null||typeof value.chatId==='string'&&value.chatId.length<=160)&&Number.isSafeInteger(value.intentEpoch)&&value.intentEpoch>=0&&Number.isSafeInteger(value.revision)&&value.revision>=0;
  default:return false;
 }
}
export function isEditorPacket(direction:'up'|'down',v:unknown):v is EditorPacket {return object(v)&&Object.keys(v).length===2&&isEditorStamp(v.stamp)&&editorMessageAllowed(direction,v.message);}
