import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {ipcMain} from 'electron';
import {prepareNativeEditorHost,nativeEditorNavigation} from '../../src/main/editor-host';
import {EDITOR_CHANNEL,EDITOR_URL} from '../../src/editor-host-wire';
vi.mock('electron',async()=>{
 const {EventEmitter}=await import('node:events');
 class Contents extends EventEmitter {id=2;mainFrame:any={url:EDITOR_URL,parent:null};dead=false;send=vi.fn();focus=vi.fn();isFocused=vi.fn(()=>false);capturePage=vi.fn(async()=>({isEmpty:()=>false,toDataURL:()=> 'data:image/png;base64,AA=='}));loadURL=vi.fn(async()=>{});setWindowOpenHandler=vi.fn();isDestroyed(){return this.dead;}close(){this.dead=true;this.emit('destroyed');}}
 class View {webContents=new Contents();setBounds=vi.fn();setVisible=vi.fn();constructor(readonly options:unknown){}}
 return{ipcMain:new EventEmitter(),WebContentsView:View};
});
const disposers:(()=>void)[]=[];afterEach(()=>{for(const dispose of disposers.splice(0))dispose();});
function fixture(ownerReady:Promise<void>=Promise.resolve()){
 const contents=Object.assign(new EventEmitter(),{id:1,mainFrame:{url:'app://botling/index.html',parent:null},isDestroyed:()=>false,send:vi.fn(),focus:vi.fn()});
 const owner=Object.assign(new EventEmitter(),{webContents:contents,isVisible:():boolean=>false,isDestroyed:():boolean=>false,getContentBounds:()=>({x:0,y:0,width:1120,height:820}),contentView:{addChildView:vi.fn(),removeChildView:vi.fn()},focus:vi.fn(),show:vi.fn()});
 const result=prepareNativeEditorHost(owner as any,'/Volumes/My-SSD/synthetic/desktop',ownerReady);disposers.push(result.dispose);return{owner,...result};
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
 f.owner.isVisible=()=>true;
 (contents as any).isFocused.mockReturnValue(true);
 f.owner.webContents.emit('did-start-navigation',{isMainFrame:true});f.owner.webContents.mainFrame={url:'app://botling/index.html',parent:null};f.owner.webContents.emit('did-finish-load');
 expect(f.owner.webContents.focus).toHaveBeenCalledTimes(1);
 const bound=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.bound).at(-1)![1];expect(bound.surfaceId).toBe(first.surfaceId);expect(bound.documentGeneration).not.toBe(first.documentGeneration);expect(f.owner.contentView.addChildView).toHaveBeenCalledTimes(1);expect(contents.loadURL).toHaveBeenCalledTimes(1);
 f.owner.webContents.send.mockClear();ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:first,message:{botling:'stop'}});expect(f.owner.webContents.send).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp:bound,message:{botling:'stop'}});expect(f.owner.webContents.send).toHaveBeenCalledTimes(1);
 f.dispose();expect(f.owner.webContents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.unbound,bound);expect(f.owner.contentView.removeChildView).toHaveBeenCalledTimes(1);expect(contents.isDestroyed()).toBe(true);expect(nativeEditorNavigation(contents,{isMainFrame:true,url:EDITOR_URL})).toBeNull();
});

it('keeps the opening window hidden until both the native editor state and its layout are ready', async () => {
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const order:string[]=[];
 (contents as any).focus=vi.fn(()=>order.push('editor.focus'));
 f.owner.show.mockImplementation(()=>order.push('window.show'));
 const reveal=(f as any).revealWhenReady(false);
 await Promise.resolve();
 expect(order).toEqual([]);
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await Promise.resolve();
 expect(order).toEqual([]);
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:200,y:60,width:600,height:600}});
 await reveal;
 expect(order).toEqual(['editor.focus','window.show','editor.focus']);
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:2,intentEpoch:0}});
 expect(order).toHaveLength(3);
});


it.each(['hidden','closed'])('never reveals or focuses an opening owner that is %s',async mode=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const reveal=f.revealWhenReady(mode==='hidden');
 if(mode==='closed'){f.owner.isDestroyed=()=>true;f.dispose();}
 else{
  ipcMain.emit(EDITOR_CHANNEL.layout,{sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame},{stamp,bounds:{x:200,y:60,width:600,height:600}});
  ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 }
 await reveal;
 expect(f.owner.show).not.toHaveBeenCalled();expect((contents as any).focus).not.toHaveBeenCalled();
});

it('does not accept forged readiness; hiding moves native focus to the shell without recreating the editor',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const reveal=f.revealWhenReady(false);
 const shellEvent={sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame};
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:{x:200,y:60,width:600,height:600}});
 ipcMain.emit(EDITOR_CHANNEL.up,shellEvent,{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await Promise.resolve();expect(f.owner.show).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.up,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'hostObservation',chatId:'main',revision:1,intentEpoch:0}});
 await reveal;
 f.owner.isVisible=()=>true;
 (contents as any).isFocused.mockReturnValue(true);
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:null});
 expect(f.owner.webContents.focus).toHaveBeenCalledTimes(1);
 expect((f.view as any).setBounds).toHaveBeenLastCalledWith({x:0,y:0,width:0,height:0});
 ipcMain.emit(EDITOR_CHANNEL.down,shellEvent,{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(2); // Hidden view refuses explicit focus too.
 expect(contents.loadURL).toHaveBeenCalledTimes(1);
 f.owner.isVisible=()=>true;
 ipcMain.emit(EDITOR_CHANNEL.layout,shellEvent,{stamp,bounds:{x:200,y:60,width:600,height:600}});
 ipcMain.emit(EDITOR_CHANNEL.down,{sender:contents,senderFrame:contents.mainFrame},{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(2);
 ipcMain.emit(EDITOR_CHANNEL.down,shellEvent,{stamp,message:{botling:'focus'}});
 expect((contents as any).focus).toHaveBeenCalledTimes(3);
 expect(contents.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.down,{stamp,message:{botling:'focus'}});
});


it.each(['snapshot','boot','disposed'])('reveals a usable shell within 3s when %s prevents native readiness',async mode=>{
 vi.useFakeTimers();
 try{
  const f=fixture(mode==='boot'?new Promise(()=>{}):Promise.resolve());
  const shown=f.revealWhenReady(false);
  if(mode==='disposed')f.dispose();
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.owner.show).toHaveBeenCalledTimes(1);
  expect(await shown).toBe(true);
  expect((f.view.webContents as any).focus).not.toHaveBeenCalled();
 }finally{vi.useRealTimers();}
});


it('keeps chat pixels underneath any registered overlay and rejects late or forged decoded-snapshot ACKs',async()=>{
 const f=fixture(),stamp=await f.ready,contents=f.view.webContents;
 const event={sender:f.owner.webContents,senderFrame:f.owner.webContents.mainFrame};
 const bounds={x:200,y:60,width:600,height:600};
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});
 const visibility=(f.view as any).setVisible;visibility.mockClear();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds,occluded:true});
 await Promise.resolve();
 expect((contents as any).capturePage).toHaveBeenCalledWith(undefined,{stayHidden:true,stayAwake:false});
 expect(visibility).not.toHaveBeenCalled();
 const captured=f.owner.webContents.send.mock.calls.filter(c=>c[0]===EDITOR_CHANNEL.snapshot).at(-1)![1];
 expect(captured.image).toBe('data:image/png;base64,AA==');
 ipcMain.emit(EDITOR_CHANNEL.layout,{sender:contents,senderFrame:contents.mainFrame},{stamp,snapshotReady:captured.revision});
 expect(visibility).not.toHaveBeenCalled();
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,snapshotReady:captured.revision});
 expect(visibility).toHaveBeenLastCalledWith(false);
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,bounds});
 expect(visibility).toHaveBeenLastCalledWith(true);
 const calls=visibility.mock.calls.length;
 ipcMain.emit(EDITOR_CHANNEL.layout,event,{stamp,snapshotReady:captured.revision});
 expect(visibility).toHaveBeenCalledTimes(calls);
 expect(contents.loadURL).toHaveBeenCalledTimes(1);
});
