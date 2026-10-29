import {expect,it,vi} from 'vitest';
vi.mock('electron',()=>{class BrowserWindow{webContents={reload:vi.fn(),reloadIgnoringCache:vi.fn()};}return{BrowserWindow,Menu:{}};});
import {BrowserWindow} from 'electron';
import {appMenuTemplate} from '../../src/main/app-menu';
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
it('Cmd+J targets the shell terminal even when a child editor has focus', () => {
 const win=new (BrowserWindow as any)();win.webContents.send=vi.fn();
 const item=flat(appMenuTemplate('darwin')).find(i=>i.accelerator==='CmdOrCtrl+J');
 item.click(item,win,{});item.click(item,undefined,{});
 expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith('botling:terminal:toggle');
});
