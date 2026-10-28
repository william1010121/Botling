// Main owns the native input surface and establishes it before the opening window is revealed.
import {WebContentsView,ipcMain,type BrowserWindow,type WebContents,type IpcMainEvent,type WebFrameMain} from 'electron';
import {join} from 'node:path';
import {EditorHostBoundary} from './editor-host-boundary';
import {EDITOR_CHANNEL,EDITOR_URL} from '../editor-host-wire';
import type {ChatLayer} from './window-capture';
const hosts=new Map<WebContents,{loaded:boolean}>(),owners=new Set<WebContents>(),reloaders=new Map<WebContents,()=>Promise<boolean>>(),layers=new Map<WebContents,()=>ChatLayer|null>();
export const hasNativeEditorHost=(owner:WebContents)=>owners.has(owner);
/** Reload Chat Page: a fresh chat document (new chat.js/css, new preload) in the same native view.
 * The shell sees unbound, then bound with a new document generation, and pushes state again. */
export const reloadNativeEditor=(owner:WebContents):Promise<boolean>=>reloaders.get(owner)?.()??Promise.resolve(false);
/** The native chat as drawn over its shell right now (window-capture.ts), or null when it is not showing. */
export const nativeEditorLayer=(owner:WebContents):ChatLayer|null=>layers.get(owner)?.()??null;
const card=(url:string,host:string)=>{try{const u=new URL(url);return u.protocol==='botling-card:'&&u.host===host&&!u.username&&!u.password;}catch{return false;}};
export function nativeEditorNavigation(contents:WebContents,details:{isMainFrame:boolean;url:string;frame?:WebFrameMain|null;initiator?:WebFrameMain|null}):boolean|null {
 const host=hosts.get(contents);if(!host)return null;
 if(details.isMainFrame)return !host.loaded&&details.url===EDITOR_URL;
 const root=contents.mainFrame,parent=details.frame?.parent,initiator=details.initiator;
 if(card(details.url,'card')||card(details.url,'page'))return parent===root&&(!initiator||initiator===root);
 if(card(details.url,'preview'))return !!parent&&parent.parent===root&&card(parent.url,'page')&&(!initiator||initiator===parent);
 return false;
}
/** The shell measures in CSS pixels; a zoomed shell (Cmd-minus) scales them to window DIPs. */
export function editorBounds(value:unknown,size:{width:number;height:number},zoom=1):Electron.Rectangle|null {
 if(!value||typeof value!=='object')return null;const v=value as Record<string,unknown>,keys=['x','y','width','height'];
 if(Object.keys(v).length!==4||keys.some(k=>typeof v[k]!=='number'||!Number.isFinite(v[k])))return null;
 if(!Number.isFinite(zoom)||zoom<=0)return null;
 const r=Object.fromEntries(keys.map(k=>[k,Math.round((v[k] as number)*zoom)])) as unknown as Electron.Rectangle;
 // Rounding a zoomed rect may overshoot the window edge by a pixel; anything more is refused below.
 if(r.x+r.width===size.width+1)r.width--;if(r.y+r.height===size.height+1)r.height--;
 return r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=size.width&&r.y+r.height<=size.height?r:null;
}
/** One unprivileged root editor, bound to its shell. No renderer-callable mount or key replay.
 * The caller uses revealWhenReady to gate window reveal on editor state and authenticated layout. */
export function prepareNativeEditorHost(owner:BrowserWindow,desktopRoot:string,ownerReady:Promise<void>,preloadDirectory=join(desktopRoot,'out/preload')){
 if(owner.isVisible())throw new Error('Prepare the native editor before window reveal');
 const view=new WebContentsView({webPreferences:{preload:join(preloadDirectory,'editor-host.cjs'),additionalArguments:['--botling-editor-host=1'],sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false,spellcheck:false}});
 let laidOut=false,initialized=false,closed=false,occluded=false,snapshotRevision=0;
 let snapshotTimer:ReturnType<typeof setTimeout>|undefined;
 let snapshotDirty=false,captureInFlight=false,lastCaptureAt=-Infinity;
 let lastBounds:Electron.Rectangle|undefined;
 let settleInitial!:(ready:boolean)=>void;
 const initial=new Promise<boolean>(resolve=>{settleInitial=resolve;});
 const checkInitial=()=>{if(laidOut&&initialized)settleInitial(true);};
 const contents=view.webContents,ownerContents=owner.webContents,boundary=new EditorHostBoundary(),host={loaded:false};hosts.set(contents,host);owners.add(ownerContents);view.setBounds({x:0,y:0,width:0,height:0});owner.contentView.addChildView(view);
 contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-attach-webview',event=>event.preventDefault());
 const up=(event:IpcMainEvent,packet:unknown)=>{const route=boundary.route('up',event,packet);if(!route)return;
  const message=route.packet.message as {botling?:string;chatId?:unknown;revision?:number};
  if(message.botling==='hostObservation'&&message.chatId!==null&&(message.revision ?? 0)>0){initialized=true;checkInitial();if(occluded)invalidateSnapshot();}
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
 const stopSnapshots=()=>{clearTimeout(snapshotTimer);snapshotTimer=undefined;snapshotDirty=false;snapshotRevision++;};
 // Capture once on cover, then only after applied chat state or changed bounds. Coalesce bursts
 // without postponing the next capture, never overlap captures, and keep the 1s cap across covers.
 const scheduleSnapshot=()=>{
  if(closed||!occluded||!snapshotDirty||captureInFlight||snapshotTimer!==undefined)return;
  const delay=Math.max(0,1000-(Date.now()-lastCaptureAt));
  if(delay===0)void captureSnapshot();
  else snapshotTimer=setTimeout(()=>{snapshotTimer=undefined;void captureSnapshot();},delay);
 };
 // Revision belongs to the cover lifetime. Streaming state may dirty the next capture while
 // the current one is in flight; it must still be displayable so active streams cannot starve it.
 const invalidateSnapshot=()=>{snapshotDirty=true;scheduleSnapshot();};
 const captureSnapshot=async()=>{
  if(closed||!occluded||!snapshotDirty||captureInFlight)return;
  snapshotDirty=false;captureInFlight=true;lastCaptureAt=Date.now();
  const revision=snapshotRevision;
  try{
   const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:false});
   if(!closed&&occluded&&revision===snapshotRevision&&!image.isEmpty())snapshot(image.toDataURL());
  }catch{/* A crash may have disposed this view; shell reveal must remain independent. */}
  finally{captureInFlight=false;scheduleSnapshot();}
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
  const bounds=editorBounds(value.bounds,owner.getContentBounds(),ownerContents.getZoomFactor());if(!bounds)return;
  const boundsChanged=!lastBounds||(['x','y','width','height'] as const).some(key=>lastBounds![key]!==bounds[key]);
  lastBounds=bounds;view.setBounds(bounds);
  if(value.occluded===true){
   // Quick settings must be usable before capture/PNG decode (or the 1s capture budget).
   // The snapshot fills the background asynchronously; other overlays keep their handoff.
   if(value.revealImmediately===true){
    view.setVisible(false);
    if(owner.isVisible()&&contents.isFocused())owner.webContents.focus();
   }
   if(!occluded){occluded=true;laidOut=false;stopSnapshots();invalidateSnapshot();}
   else if(boundsChanged)invalidateSnapshot();
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
 const dispose=()=>{if(closed)return;closed=true;stopSnapshots();settleInitial(false);if(lastStamp&&!ownerContents.isDestroyed())ownerContents.send(EDITOR_CHANNEL.unbound,lastStamp);boundary.revoke(contents);owner.removeListener('closed',dispose);hosts.delete(contents);owners.delete(ownerContents);reloaders.delete(ownerContents);layers.delete(ownerContents);ownerContents.removeListener('did-start-navigation',ownerNavigation);ownerContents.removeListener('did-finish-load',ownerLoaded);ipcMain.removeListener(EDITOR_CHANNEL.up,up);ipcMain.removeListener(EDITOR_CHANNEL.down,down);ipcMain.removeListener(EDITOR_CHANNEL.layout,layout);if(!owner.isDestroyed())owner.contentView.removeChildView(view);if(!contents.isDestroyed())contents.close();};
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

 // Only main starts this navigation; any other main-frame navigation of the editor still disposes it.
 // The view, its bounds and the window's layout stay; chat state comes back from the core via the shell.
 let reloading:Promise<boolean>|undefined;
 const reload=():Promise<boolean>=>{
  if(reloading)return reloading;
  if(closed||!host.loaded||contents.isDestroyed())return Promise.resolve(false);
  const hadFocus=contents.isFocused();
  host.loaded=false;boundary.revoke(contents);if(lastStamp&&!ownerContents.isDestroyed())ownerContents.send(EDITOR_CHANNEL.unbound,lastStamp);
  // loadURL of the same URL can reuse renderer memory-cache scripts even after
  // session.clearCache(). Hot install must replace chat.js before the new shell runs.
  const loaded=new Promise<void>((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);contents.removeListener('did-finish-load',finished);contents.removeListener('did-fail-load',failed);contents.removeListener('destroyed',destroyed);};
   const finished=()=>{cleanup();resolve();};
   const failed=(_event:Electron.Event,code:number,description:string,_url:string,main:boolean)=>{if(main){cleanup();reject(new Error(`Chat reload failed (${code}): ${description}`));}};
   const destroyed=()=>{cleanup();reject(new Error('Chat closed during reload'));};
   const timer=setTimeout(()=>{cleanup();reject(new Error('Chat reload timed out'));},30_000);
   contents.once('did-finish-load',finished);contents.on('did-fail-load',failed);contents.once('destroyed',destroyed);
   try{contents.reloadIgnoringCache();}catch(error){cleanup();reject(error);}
  });
  reloading=loaded.then(()=>{
   if(closed||owner.isDestroyed())return false;
   host.loaded=true;
   // A shell that is itself mid-navigation is bound again by its own did-finish-load.
   try{bindOwner();}catch{/* ownerLoaded rebinds */}
   if(hadFocus&&laidOut&&owner.isVisible())contents.focus();
   return true;
  },()=>{dispose();return false;}).finally(()=>{reloading=undefined;});
  return reloading;
 };
 reloaders.set(ownerContents,reload);
 // Only a laid-out, uncovered view is on screen; its bounds are window DIPs, as the shell's own capture.
 layers.set(ownerContents,()=>closed||!laidOut||occluded||!lastBounds||contents.isDestroyed()?null
  :{bounds:{...lastBounds},capture:()=>contents.capturePage(undefined,{stayHidden:true,stayAwake:false})});
 void ready.catch(dispose);return{view,ready,dispose,revealWhenReady,reload};
}
