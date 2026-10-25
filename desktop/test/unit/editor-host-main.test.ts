import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {ipcMain} from 'electron';
import {prepareNativeEditorHost,nativeEditorNavigation} from '../../src/main/editor-host';
import {EDITOR_CHANNEL,EDITOR_URL} from '../../src/editor-host-wire';
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events');
 class Contents extends EventEmitter {id=2;mainFrame:any={url:EDITOR_URL,parent:null};dead=false;send=vi.fn();loadURL=vi.fn(async()=>{});setWindowOpenHandler=vi.fn();isDestroyed(){return this.dead;}close(){this.dead=true;this.emit('destroyed');}}
 class View {webContents=new Contents();setBounds=vi.fn();constructor(readonly options:unknown){}}
 return{ipcMain:new EventEmitter(),WebContentsView:View};
});
const disposers:(()=>void)[]=[];afterEach(()=>{for(const dispose of disposers.splice(0))dispose();});
function fixture(){
 const contents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:'app://botling/index.html',parent:null},isDestroyed:()=>false,send:vi.fn()});
 const owner=Object.assign(new EventEmitter(),{webContents:contents,isVisible:()=>false,isDestroyed:()=>false,getContentBounds:()=>({x:0,y:0,width:1120,height:820}),contentView:{addChildView:vi.fn(),removeChildView:vi.fn()},focus:vi.fn(),show:vi.fn()});
 const result=prepareNativeEditorHost(owner as any,'/Volumes/My-SSD/synthetic/desktop',Promise.resolve());disposers.push(result.dispose);return{owner,...result};
}
it('creates only a sandboxed separate native root with narrow preload, no focus/reveal, and rejects navigation escapes',async()=>{
 const f=fixture(),contents=f.view.webContents,root=contents.mainFrame;
 expect((f.view as any).options.webPreferences).toMatchObject({preload:'/Volumes/My-SSD/synthetic/desktop/out/preload/editor-host.cjs',sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,nodeIntegrationInWorker:false,webSecurity:true,additionalArguments:['--botling-editor-host=1']});
 expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(true);await f.ready;
 expect(f.owner.show).not.toHaveBeenCalled();expect(f.owner.focus).not.toHaveBeenCalled();expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBe(false);
 expect(nativeEditorNavigation(contents,{isMainFrame:false,url:'botling-card://card/synthetic',frame:{parent:root} as any,initiator:root})).toBe(true);
 expect(nativeEditorNavigation(contents,{isMainFrame:false,url:'botling-card://preview/synthetic',frame:{parent:{parent:root,url:'botling-card://page/synthetic'}} as any})).toBe(true);
 for(const url of ['app://botling/index.html','https://example.invalid','file:///synthetic','botling-chat://chat/chat.html'])expect(nativeEditorNavigation(contents,{isMainFrame:false,url,frame:{parent:root} as any,initiator:root})).toBe(false);
});
it('main relay and layout authenticate the exact shell/editor roots; plugin messages cannot move or privilege the view',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents,bounds={x:200,y:60,width:600,height:600},layout=(f.view as any).setBounds;layout.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:contents,senderFrame:contents.mainFrame},{stamp,bounds});expect(layout).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds});expect(layout).toHaveBeenCalledExactlyOnceWith(bounds);
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:0,y:0,width:5000,height:5000}});expect(layout).toHaveBeenCalledTimes(1);
 f.owner.webContents.send.mockClear();ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'request',id:1,cmd:{type:'accounts.list'}}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledExactlyOnceWith(EDITOR_CHANNEL.shell,{stamp,message:{botling:'stop'}});
});
it('shell document reload rotates authentication while retaining the native editor view and load',async()=>{
 const f=fixture(),first=await f.ready,contents=f.view.webContents;
 f.owner.webContents.emit('did-start-navigation',{isMainFrame:true});f.owner.webContents.mainFrame={url:'app://botling/index.html',parent:null};f.owner.webContents.emit('did-finish-load');
 const bound=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.bound).at(-1)![1];expect(bound.surfaceId).toBe(first.surfaceId);expect(bound.documentGeneration).not.toBe(first.documentGeneration);expect(f.owner.contentView.addChildView).toHaveBeenCalledTimes(1);expect(contents.loadURL).toHaveBeenCalledTimes(1);
 f.owner.webContents.send.mockClear();ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:first,message:{botling:'stop'}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:bound,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
 f.dispose();expect(f.owner.webContents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.unbound,bound);expect(f.owner.contentView.removeChildView).toHaveBeenCalledTimes(1);expect(contents.isDestroyed()).toBe(true);expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBeNull();
});
