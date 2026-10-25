// Dormant main-owned native view. No caller/activation is added in this change.
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
/** Integration must remove the legacy chat iframe, keep the shell hidden until ready/layout,
 * and establish one native input owner before reveal. This factory never focuses/shows a window.
 * It intentionally has no renderer-callable mount operation or environment toggle. */
export function prepareNativeEditorHost(owner:BrowserWindow,desktopRoot:string,ownerReady:Promise<void>){
 if(owner.isVisible())throw new Error('Prepare the native editor before window reveal');
 const view=new WebContentsView({webPreferences:{preload:join(desktopRoot,'out/preload/editor-host.cjs'),additionalArguments:['--botling-editor-host=1'],sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,allowRunningInsecureContent:false,navigateOnDragDrop:false,spellcheck:false}});
 const contents=view.webContents,boundary=new EditorHostBoundary(),host={loaded:false};hosts.set(contents,host);owners.add(owner.webContents);view.setBounds({x:0,y:0,width:0,height:0});owner.contentView.addChildView(view);
 contents.setWindowOpenHandler(()=>({action:'deny'}));contents.on('will-attach-webview',event=>event.preventDefault());
 const up=(event:IpcMainEvent,packet:unknown)=>{const route=boundary.route('up',event,packet);if(route)owner.webContents.send(EDITOR_CHANNEL.shell,route.packet);};
 const down=(event:IpcMainEvent,packet:unknown)=>{const route=boundary.route('down',event,packet);if(route)contents.send(EDITOR_CHANNEL.down,route.packet);};
 const layout=(event:IpcMainEvent,value:any)=>{if(boundary.receiver('down',event,value?.stamp)!==contents)return;if(value?.bounds===null){view.setBounds({x:0,y:0,width:0,height:0});return;}const bounds=editorBounds(value?.bounds,owner.getContentBounds());if(bounds)view.setBounds(bounds);};
 ipcMain.on(EDITOR_CHANNEL.up,up);ipcMain.on(EDITOR_CHANNEL.down,down);ipcMain.on(EDITOR_CHANNEL.layout,layout);
 let closed=false,surfaceId:string|undefined,lastStamp:import('../editor-host-wire').EditorStamp|undefined;
 const invalidateOwner=()=>{boundary.revoke(owner.webContents);if(lastStamp&&!contents.isDestroyed())contents.send(EDITOR_CHANNEL.unbound,lastStamp);};
 const bindOwner=()=>{if(closed||!host.loaded||owner.isDestroyed())return;boundary.revoke(owner.webContents);const stamp=boundary.bind(owner.webContents,contents,surfaceId);surfaceId=stamp.surfaceId;lastStamp=stamp;owner.webContents.send(EDITOR_CHANNEL.bound,stamp);contents.send(EDITOR_CHANNEL.bound,stamp);return stamp;};
 const ownerNavigation=(details:{isMainFrame:boolean})=>{if(details.isMainFrame)invalidateOwner();};
 const editorNavigation=(details:{isMainFrame:boolean})=>{if(details.isMainFrame&&host.loaded)dispose();};
 const ownerLoaded=()=>{if(host.loaded){try{bindOwner();}catch{dispose();}}};
 const dispose=()=>{if(closed)return;closed=true;if(lastStamp&&!owner.webContents.isDestroyed())owner.webContents.send(EDITOR_CHANNEL.unbound,lastStamp);boundary.revoke(contents);owner.removeListener('closed',dispose);hosts.delete(contents);owners.delete(owner.webContents);owner.webContents.removeListener('did-start-navigation',ownerNavigation);owner.webContents.removeListener('did-finish-load',ownerLoaded);ipcMain.removeListener(EDITOR_CHANNEL.up,up);ipcMain.removeListener(EDITOR_CHANNEL.down,down);ipcMain.removeListener(EDITOR_CHANNEL.layout,layout);if(!owner.isDestroyed())owner.contentView.removeChildView(view);if(!contents.isDestroyed())contents.close();};
 owner.webContents.on('did-start-navigation',ownerNavigation);owner.webContents.on('did-finish-load',ownerLoaded);contents.on('did-start-navigation',editorNavigation);
 owner.once('closed',dispose);contents.once('render-process-gone',dispose);contents.once('destroyed',dispose);
 const ready=Promise.all([ownerReady,contents.loadURL(EDITOR_URL)]).then(()=>{if(closed||owner.isDestroyed())throw new Error('Editor owner closed before binding');host.loaded=true;return bindOwner()!;});
 void ready.catch(dispose);return{view,ready,dispose};
}
