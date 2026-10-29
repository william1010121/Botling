// Electron's default menu roles reload the focused web contents, which is usually the native chat
// editor; reloading that view disposes it and the chat goes blank. Reload always targets the shell.
// Reload Chat Page asks main to reload the native chat page in place (editor-host.ts reloadNativeEditor).
import {BrowserWindow,type BaseWindow,type MenuItemConstructorOptions,type WebContents} from 'electron';
const shell=(window:BaseWindow|undefined)=>window instanceof BrowserWindow?window.webContents:undefined;
export interface AppMenuActions {reloadChat?:(shell:WebContents)=>Promise<boolean>}
export function appMenuTemplate(platform:NodeJS.Platform=process.platform,actions:AppMenuActions={}):MenuItemConstructorOptions[]{
 const {reloadChat}=actions;
 const view:MenuItemConstructorOptions={label:'View',submenu:[
  {label:'Toggle Terminal',accelerator:'CmdOrCtrl+J',click:(_item,window)=>shell(window)?.send('botling:terminal:toggle')},
  {label:'Reload',accelerator:'CmdOrCtrl+R',click:(_item,window)=>shell(window)?.reload()},
  {label:'Force Reload',accelerator:'Shift+CmdOrCtrl+R',click:(_item,window)=>shell(window)?.reloadIgnoringCache()},
  ...(reloadChat?[{label:'Reload Chat Page',accelerator:'Alt+CmdOrCtrl+R',click:(_item,window)=>{const contents=shell(window);if(contents)void reloadChat(contents);}} satisfies MenuItemConstructorOptions]:[]),
  {role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'},
 ]};
 return [...(platform==='darwin'?[{role:'appMenu'} as const]:[]),{role:'fileMenu'},{role:'editMenu'},view,{role:'windowMenu'}];
}
