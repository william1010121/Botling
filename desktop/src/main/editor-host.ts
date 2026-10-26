// Main owns the native input surface and establishes it before the opening window is revealed.
import {WebContentsView,ipcMain,type BrowserWindow,type WebContents,type IpcMainEvent,type WebFrameMain} from 'electron';
import {join} from 'node:path';
import {EditorHostBoundary} from './editor-host-boundary';
import {EDITOR_CHANNEL,EDITOR_URL} from '../editor-host-wire';
const hosts=new Map<WebContents,{loaded:boolean}>(),owners=new Set<WebContents>();
export const hasNativeEditorHost=(owner:WebContents)=>owners.has(owner);
const card=(url:string,host:string)=>{try{const u=new URL(url);return u.protocol==='botling-card:'&&u.host===host&&!u.username&&!u.password;}catch{return false;}};
export function nativeEditorNavigation(contents:WebContents,details:{isMainFrame:boolean;url:string;frame?:WebFrameMain|null;initiator?:WebFrameMain|null}):boolean|null {
 const host=hosts.get(contents);if(!host)return null;
 if(details.isMainFrame)return !host.loaded&&details.url===EDITOR_URL;
 const root=contents.mainFrame,parent=details.frame?.parent,initiator=details.initiator;
 if(card(details.url,'card')||card(details.url,'page'))return parent===root&&(!initiator||initiator===root);
 if(card(details.url,'preview'))return !!parent&&parent.parent===root&&card(parent.url,'page')&&(!initiator||initiator===parent);
 return false;
}
export function editorBounds(value:unknown,size:{width:number;height:number}):Electron.Rectangle|null {
 if(!value||typeof value!=='object')return null;const v=value as Record<string,unknown>,keys=['x','y','width','height'];
 if(Object.keys(v).length!==4||keys.some(k=>typeof v[k]!=='number'||!Number.isFinite(v[k])))return null;
 const r=Object.fromEntries(keys.map(k=>[k,Math.round(v[k] as number)])) as unknown as Electron.Rectangle;
 return r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=size.width&&r.y+r.height<=size.height?r:null;
}
/** One unprivileged root editor, bound to its shell. No renderer-callable mount or key replay.
 * The caller uses revealWhenReady to gate window reveal on editor state and authenticated layout. */
export function prepareNativeEditorHost(owner:BrowserWindow,desktopRoot:string,ownerReady:Promise<void>){
 if(owner.isVisible())throw new Error('Prepare the native editor before window reveal');
 const view=new WebContentsView({webPreferences:{preload:join(desktopRoot,'out/preload/editor-host.cjs'),additionalArguments:['--botling-editor-host=1'],sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false,spellcheck:false}});
 let laidOut=false,initialized=false,closed=false,occluded=false,snapshotRevision=0;
 let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
 let settleInitial!:(ready:boolean)=>void;
 const initial=new Promise<boolean>(resolve=>{settleInitial=resolve;});
 const checkInitial=()=>{if(laidOut&&initialized)settleInitial(true);};
 const contents=view.webContents,boundary=new EditorHostBoundary(),host={loaded:false};hosts.set(contents,host);owners.add(owner.webContents);view.setBounds({x:0,y:0,width:0,height:0});owner.contentView.addChildView(view);
 contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-attach-webview',event=>event.preventDefault());
 const up=(event:IpcMainEvent,packet:unknown)=>{const route=boundary.route('up',event,packet);if(!route)return;
  const message=route.packet.message as {botling?:string;chatId?:unknown;revision?:number};
  if(message.botling==='hostObservation'&&message.chatId!==null&&(message.revision ?? 0)>0){initialized=true;checkInitial();}
  owner.webContents.send(EDITOR_CHANNEL.shell,route.packet);
 };
 const down=(event:IpcMainEvent,packet:unknown)=>{const route=boundary.route('down',event,packet);if(!route)return;
  // Only the authenticated shell can request an explicit return from search to the composer.
  if((route.packet.message as {botling?:string}).botling==='focus'){if(!laidOut||!owner.isVisible())return;contents.focus();}
  contents.send(EDITOR_CHANNEL.down,route.packet);
 };
 const snapshot=(image:string|null)=>{
  if(lastStamp&&!owner.webContents.isDestroyed())owner.webContents.send(EDITOR_CHANNEL.snapshot,{stamp:lastStamp,image,revision:snapshotRevision});
 };
 const stopSnapshots=()=>{clearTimeout(snapshotTimer);snapshotRevision++;};
 const captureSnapshot=async(revision:number)=>{
  try{
   const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:false});
   if(closed||!occluded||revision!==snapshotRevision)return;
   if(!image.isEmpty())snapshot(image.toDataURL());
  }catch{/* A crash may have disposed this view; shell reveal must remain independent. */}
  if(!closed&&occluded&&revision===snapshotRevision)snapshotTimer=setTimeout(()=>void captureSnapshot(revision),250);
 };
 const layout=(event:IpcMainEvent,value:any)=>{
  if(boundary.receiver('down',event,value?.stamp)!==contents)return;
  if(value.snapshotReady!==undefined){
   // Hide only after the shell has decoded the matching pixels. A closed overlay's late ACK
   // cannot hide a restored editor. The snapshot is display-only and cannot receive input.
   if(occluded&&value.snapshotReady===snapshotRevision)view.setVisible(false);
   return;
  }
  if(value.bounds===null){
   stopSnapshots();occluded=false;laidOut=false;view.setVisible(false);view.setBounds({x:0,y:0,width:0,height:0});snapshot(null);
   if(owner.isVisible()&&contents.isFocused())owner.webContents.focus();return;
  }
  const bounds=editorBounds(value.bounds,owner.getContentBounds());if(!bounds)return;
  view.setBounds(bounds);
  if(value.occluded===true){
   if(!occluded){occluded=true;laidOut=false;stopSnapshots();void captureSnapshot(snapshotRevision);}
  }else{
   stopSnapshots();occluded=false;view.setVisible(true);snapshot(null);laidOut=true;checkInitial();
  }
 };

 ipcMain.on(EDITOR_CHANNEL.up,up);ipcMain.on(EDITOR_CHANNEL.down,down);ipcMain.on(EDITOR_CHANNEL.layout,layout);
 let surfaceId:string|undefined,lastStamp:import('../editor-host-wire').EditorStamp|undefined;
 const invalidateOwner=()=>{boundary.revoke(owner.webContents);if(lastStamp&&!contents.isDestroyed())contents.send(EDITOR_CHANNEL.unbound,lastStamp);};
 const bindOwner=()=>{if(closed||!host.loaded||owner.isDestroyed())return;boundary.revoke(owner.webContents);const stamp=boundary.bind(owner.webContents,contents,surfaceId);surfaceId=stamp.surfaceId;lastStamp=stamp;owner.webContents.send(EDITOR_CHANNEL.bound,stamp);contents.send(EDITOR_CHANNEL.bound,stamp);return stamp;};
 const ownerNavigation=(details:{isMainFrame:boolean})=>{if(details.isMainFrame){stopSnapshots();occluded=false;laidOut=false;initialized=false;view.setBounds({x:0,y:0,width:0,height:0});view.setVisible(false);if(owner.isVisible()&&contents.isFocused())owner.webContents.focus();invalidateOwner();}};
 const editorNavigation=(details:{isMainFrame:boolean})=>{if(details.isMainFrame&&host.loaded)dispose();};
 const ownerLoaded=()=>{if(host.loaded){try{bindOwner();}catch{dispose();}}};
 const dispose=()=>{if(closed)return;closed=true;stopSnapshots();settleInitial(false);if(lastStamp&&!owner.webContents.isDestroyed())owner.webContents.send(EDITOR_CHANNEL.unbound,lastStamp);boundary.revoke(contents);owner.removeListener('closed',dispose);hosts.delete(contents);owners.delete(owner.webContents);owner.webContents.removeListener('did-start-navigation',ownerNavigation);owner.webContents.removeListener('did-finish-load',ownerLoaded);ipcMain.removeListener(EDITOR_CHANNEL.up,up);ipcMain.removeListener(EDITOR_CHANNEL.down,down);ipcMain.removeListener(EDITOR_CHANNEL.layout,layout);if(!owner.isDestroyed())owner.contentView.removeChildView(view);if(!contents.isDestroyed())contents.close();};
 owner.webContents.on('did-start-navigation',ownerNavigation);owner.webContents.on('did-finish-load',ownerLoaded);contents.on('did-start-navigation',editorNavigation);
 owner.once('closed',dispose);contents.once('render-process-gone',dispose);contents.once('destroyed',dispose);
 const ready=Promise.all([ownerReady,contents.loadURL(EDITOR_URL)]).then(()=>{if(closed||owner.isDestroyed())throw new Error('Editor owner closed before binding');host.loaded=true;return bindOwner()!;});
 const revealWhenReady=async(hidden:boolean)=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  // Core boot, update recovery or the first snapshot can fail independently of the shell.
  // Never let those dependencies (or editor disposal) suppress the window indefinitely.
  const inputReady=await Promise.race([initial,new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),3000);})]);
  clearTimeout(timer);
  if(owner.isDestroyed()||hidden)return false;
  const ownInput=inputReady&&!closed&&laidOut&&initialized&&!contents.isDestroyed();
  if(ownInput)contents.focus();
  owner.show();
  if(ownInput)contents.focus();
  return true;
 };

 void ready.catch(dispose);return{view,ready,dispose,revealWhenReady};
}
