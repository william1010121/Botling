// Electron's default menu roles reload the focused web contents, which is usually the native chat
// editor; reloading that view disposes it and the chat goes blank. Reload always targets the shell.
import {BrowserWindow,type BaseWindow,type MenuItemConstructorOptions} from 'electron';
const shell=(window:BaseWindow|undefined)=>window instanceof BrowserWindow?window.webContents:undefined;
export function appMenuTemplate(platform:NodeJS.Platform=process.platform):MenuItemConstructorOptions[]{
 const view:MenuItemConstructorOptions={label:'View',submenu:[
  {label:'Reload',accelerator:'CmdOrCtrl+R',click:(_item,window)=>shell(window)?.reload()},
  {label:'Force Reload',accelerator:'Shift+CmdOrCtrl+R',click:(_item,window)=>shell(window)?.reloadIgnoringCache()},
  {role:'toggleDevTools'},{type:'separator'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'},
 ]};
 return [...(platform==='darwin'?[{role:'appMenu'} as const]:[]),{role:'fileMenu'},{role:'editMenu'},view,{role:'windowMenu'}];
}
