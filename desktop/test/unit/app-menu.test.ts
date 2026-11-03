import {expect,it,vi} from 'vitest';
vi.mock('electron',()=>{class BrowserWindow{webContents={reload:vi.fn(),reloadIgnoringCache:vi.fn()};}return{BrowserWindow,Menu:{}};});
import {BrowserWindow} from 'electron';
import {appMenuTemplate} from '../../src/main/app-menu';
import {bindingsFor} from '../../src/contract/shortcuts';
const flat=(items:any[]):any[]=>items.flatMap(i=>[i,...flat(Array.isArray(i.submenu)?i.submenu:[])]);
it('Cmd+R reloads the window shell, never the focused native chat editor',()=>{
 const items=flat(appMenuTemplate('darwin')),win=new (BrowserWindow as any)(),editor={reload:vi.fn(),reloadIgnoringCache:vi.fn()};
 // The default roles act on the focused web contents, which is the chat editor; its reload disposes the chat.
 expect(items.filter(i=>/^(reload|forcereload)$/i.test(i.role??''))).toEqual([]);
 const reload=items.find(i=>i.accelerator==='CmdOrCtrl+R'),force=items.find(i=>i.accelerator==='Shift+CmdOrCtrl+R');
 reload.click(reload,win,{});force.click(force,win,{});reload.click(reload,undefined,{});
 expect(win.webContents.reload).toHaveBeenCalledTimes(1);expect(win.webContents.reloadIgnoringCache).toHaveBeenCalledTimes(1);
 expect(editor.reload).not.toHaveBeenCalled();
 expect(items.some(i=>i.role==='editMenu')).toBe(true);
});
it('Reload Chat Page reloads only that window\'s native chat page, through main', () => {
 const reloadChat=vi.fn(async()=>true),items=flat(appMenuTemplate('darwin',{reloadChat})),win=new (BrowserWindow as any)();
 const item=items.find(i=>i.label==='Reload Chat Page');
 expect(item.accelerator).toBe('Alt+CmdOrCtrl+R');
 item.click(item,win,{});item.click(item,undefined,{});
 expect(reloadChat).toHaveBeenCalledExactlyOnceWith(win.webContents);
 expect(win.webContents.reload).not.toHaveBeenCalled();
 // Without a handler (older callers) the item is absent rather than dead.
 expect(flat(appMenuTemplate('darwin')).some(i=>i.label==='Reload Chat Page')).toBe(false);
});
it('menu accelerators follow the saved bindings, and fall back to the defaults', () => {
 const items=flat(appMenuTemplate('darwin',{reloadChat:async()=>true},bindingsFor({reload:'Mod+Shift+L'})));
 expect(items.find(i=>i.label==='Reload').accelerator).toBe('Shift+CmdOrCtrl+L');
 expect(items.find(i=>i.label==='Force Reload').accelerator).toBe('Shift+CmdOrCtrl+R');
 expect(items.find(i=>i.label==='Reload Chat Page').accelerator).toBe('Alt+CmdOrCtrl+R');
 // The Terminal's key (Mod+J) is a plugin command's now, not the menu's.
 expect(items.some(i=>i.accelerator==='CmdOrCtrl+J'||i.label==='Toggle Terminal')).toBe(false);
});
it('leaves the accelerators off while a new key is being recorded', () => {
 const items=flat(appMenuTemplate('darwin',{reloadChat:async()=>true},bindingsFor({}),true));
 for(const label of ['Reload','Force Reload','Reload Chat Page'])expect(items.find(i=>i.label===label).accelerator).toBeUndefined();
});
