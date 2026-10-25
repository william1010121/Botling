// Security boundary only: no view construction, mount, focus, window reveal or runtime opt-in.
// Main must register actual WebContents/main-frame objects; URL or a renderer stamp is not authority.
import {randomUUID} from 'node:crypto';
import {EDITOR_URL,isEditorPacket,isEditorStamp,type EditorStamp,type EditorPacket} from '../editor-host-wire';
export interface EditorFrame {url:string}
export interface EditorContents {id:number;mainFrame:EditorFrame;isDestroyed():boolean}
export interface EditorSender {sender:EditorContents;senderFrame:EditorFrame|null}
interface Peer {contents:EditorContents;frame:EditorFrame}
interface Binding {stamp:EditorStamp;shell:Peer;editor:Peer}
export class EditorHostBoundary {
 private bindings=new Map<string,Binding>();
 bind(shell:EditorContents,editor:EditorContents,surfaceId:string=randomUUID()):EditorStamp {
  if(shell===editor||shell.id===editor.id||!this.valid({contents:shell,frame:shell.mainFrame},'app://botling/index.html')||!this.valid({contents:editor,frame:editor.mainFrame},EDITOR_URL))throw new Error('Editor host needs separate authenticated root documents');
  for(const value of this.bindings.values())if([value.shell.contents,value.editor.contents].some(c=>c===shell||c===editor||c.id===shell.id||c.id===editor.id))throw new Error('A native editor or shell is already bound');
  if(!/^[A-Za-z0-9-]{1,80}$/.test(surfaceId)||this.bindings.has(surfaceId))throw new Error('Invalid or duplicate editor surface');
  const stamp=Object.freeze({surfaceId,documentGeneration:randomUUID()});this.bindings.set(stamp.surfaceId,{stamp,shell:{contents:shell,frame:shell.mainFrame},editor:{contents:editor,frame:editor.mainFrame}});return stamp;
 }
 revoke(contents:EditorContents):void {for(const [id,binding] of this.bindings)if(binding.shell.contents===contents||binding.editor.contents===contents)this.bindings.delete(id);}
 private valid(peer:Peer,url:string):boolean {try{return !peer.contents.isDestroyed()&&peer.contents.mainFrame===peer.frame&&peer.frame.url===url;}catch{return false;}}
 receiver(direction:'up'|'down',event:EditorSender,stamp:unknown):EditorContents|null {
  try{
   if(!isEditorStamp(stamp))return null;const binding=this.bindings.get(stamp.surfaceId);
   if(!binding||stamp.documentGeneration!==binding.stamp.documentGeneration||!this.valid(binding.shell,'app://botling/index.html')||!this.valid(binding.editor,EDITOR_URL))return null;
   const source=direction==='up'?binding.editor:binding.shell,target=direction==='up'?binding.shell:binding.editor;
   return event.sender===source.contents&&event.senderFrame===source.frame?target.contents:null;
  }catch{return null;}
 }
 route(direction:'up'|'down',event:EditorSender,packet:unknown):{recipient:EditorContents;packet:EditorPacket}|null {
  if(!isEditorPacket(direction,packet))return null;const recipient=this.receiver(direction,event,packet.stamp);return recipient?{recipient,packet}:null;
 }
}
