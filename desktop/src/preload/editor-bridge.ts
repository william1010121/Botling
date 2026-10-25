import {EDITOR_CHANNEL,isEditorPacket,isEditorStamp,type EditorStamp,type EditorPacket} from '../editor-host-wire';
interface Transport {on(channel:string,listener:(event:unknown,value:unknown)=>void):unknown;send(channel:string,value:unknown):void}
export function editorBridge(ipc:Transport,role:'shell'|'editor'){
 let stamp:EditorStamp|null=null;const listeners=new Set<(packet:EditorPacket|{stamp:EditorStamp;bound:true}|{stamp:EditorStamp;unbound:true})=>void>();
 const incoming=role==='editor'?'down':'up',outgoing=role==='editor'?'up':'down';
 ipc.on(EDITOR_CHANNEL.bound,(_event,value)=>{if(!isEditorStamp(value))return;stamp=Object.freeze({...value});for(const listener of listeners)listener({stamp,bound:true});});
 ipc.on(EDITOR_CHANNEL.unbound,(_event,value)=>{if(!stamp||!isEditorStamp(value)||value.surfaceId!==stamp.surfaceId||value.documentGeneration!==stamp.documentGeneration)return;const previous=stamp;stamp=null;for(const listener of listeners)listener({stamp:previous,unbound:true});});
 ipc.on(role==='editor'?EDITOR_CHANNEL.down:EDITOR_CHANNEL.shell,(_event,value)=>{if(!stamp||!isEditorPacket(incoming,value)||value.stamp.surfaceId!==stamp.surfaceId||value.stamp.documentGeneration!==stamp.documentGeneration)return;for(const listener of listeners)listener(value);});
 return Object.freeze({
  version:1,current:()=>stamp,
  post(message:unknown){const packet={stamp,message};if(!stamp||!isEditorPacket(outgoing,packet))return false;ipc.send(EDITOR_CHANNEL[outgoing],packet);return true;},
  layout(bounds:unknown){if(role!=='shell'||!stamp)return false;ipc.send(EDITOR_CHANNEL.layout,{stamp,bounds});return true;},
  subscribe(listener:(packet:EditorPacket|{stamp:EditorStamp;bound:true}|{stamp:EditorStamp;unbound:true})=>void){if(typeof listener!=='function')throw new TypeError('subscribe takes a function');listeners.add(listener);if(stamp)listener({stamp,bound:true});return()=>{listeners.delete(listener);};},
 });
}
