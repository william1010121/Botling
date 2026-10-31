// Electron's default menu roles reload the focused web contents, which is usually the native chat
// editor; reloading that view disposes it and the chat goes blank. Reload always targets the shell.
// `suspended` leaves the accelerators off while Settings records a new key (the menu would eat it).
// Reload Chat Page asks main to reload the native chat page in place (editor-host.ts reloadNativeEditor).
import {BrowserWindow,type BaseWindow,type MenuItemConstructorOptions,type WebContents} from 'electron';
import {bindingsFor,toAccelerator,type Bindings} from '../contract/shortcuts';
const shell=(window:BaseWindow|undefined)=>window instanceof BrowserWindow?window.webContents:undefined;
export interface AppMenuActions {reloadChat?:(shell:WebContents)=>Promise<boolean>}
export function appMenuTemplate(platform:NodeJS.Platform=process.platform,actions:AppMenuActions={},bindings:Bindings=bindingsFor({}),suspended=false):MenuItemConstructorOptions[]{
 const {reloadChat}=actions,acc=(id:keyof Bindings)=>suspended?{}:{accelerator:toAccelerator(bindings[id])};
 const view:MenuItemConstructorOptions={label:'View',submenu:[
  {label:'Toggle Terminal',...acc('toggleTerminal'),click:(_item,window)=>shell(window)?.send('botling:terminal:toggle')},
  {label:'Reload',...acc('reload'),click:(_item,window)=>shell(window)?.reload()},
  {label:'Force Reload',...acc('forceReload'),click:(_item,window)=>shell(window)?.reloadIgnoringCache()},
  ...(reloadChat?[{label:'Reload Chat Page',...acc('reloadChat'),click:(_item,window)=>{const contents=shell(window);if(contents)void reloadChat(contents);}} satisfies MenuItemConstructorOptions]:[]),
  {role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'},
 ]};
 return [...(platform==='darwin'?[{role:'appMenu'} as const]:[]),{role:'fileMenu'},{role:'editMenu'},view,{role:'windowMenu'}];
}
