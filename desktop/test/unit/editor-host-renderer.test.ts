// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { PluginHost } from '../../../Web/src/plugins';
import { editorBridge } from '../../src/preload/editor-bridge';
import { EDITOR_CHANNEL } from '../../src/editor-host-wire';
import { chatState } from '../../src/renderer/payload';
import type { BotView } from '../../src/contract';

const bot:BotView={id:'main',name:'Main',role:'main',avatar:'square',folder:'/synthetic',phase:'awake',working:false,approvals:0,unread:0,subagents:0,problem:null,heads:['claude'],job:null,subagentRows:[]};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('mounts the real 1.x Composer in the native root before readiness and retains text, selection, undo and local plugins through observations/rebind',async()=>{
 document.body.innerHTML=readFileSync('../Web/src/chat.html','utf8').match(/<body>([\s\S]*)<\/body>/)![1];
 vi.stubGlobal('__LATEX_SOURCE__','export function activate() {}');
 vi.stubGlobal('IntersectionObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.stubGlobal('CSS',{escape:(value:string)=>value});
 const listeners=new Map<string,Function>();
 const outgoing:any[]=[];
 const bridge=editorBridge({on:(channel,fn)=>listeners.set(channel,fn),send:(channel,value)=>outgoing.push({channel,value})},'editor');
 Object.defineProperty(window,'botlingEditor',{value:bridge,configurable:true});
 const parentPost=vi.spyOn(window.parent,'postMessage');
 // Keep the actual PluginHost and Composer; replace only blob-module loading, unavailable in jsdom.
 const sync=PluginHost.prototype.sync;
 vi.spyOn(PluginHost.prototype,'sync').mockImplementation(function(this:PluginHost,specs){
  return sync.call(this,specs,async()=>ccb=>{
   if(ccb.name==='local-plugin')ccb.composer.onKeyDown(event=>{
    if(event.key!=='F2')return false;
    ccb.composer.insert('X');return true;
   });
  });
 });
 await import('../../src/renderer/chat-frame/entry');
 expect(parentPost).not.toHaveBeenCalled();
 const stamp={surfaceId:'surface',documentGeneration:'document'};
 listeners.get(EDITOR_CHANNEL.bound)!({},stamp);
 expect(outgoing.some(({value})=>value.message?.action?.type==='ready')).toBe(true);
 const payload=chatState(bot,{botId:bot.id,messages:[],running:null,live:[],tasks:[]});
 const state=()=>listeners.get(EDITOR_CHANNEL.down)!({}, {stamp,message:{botling:'state',...payload}});
 state();
 const dom=document.querySelector<HTMLElement>('.composer .cm-editor')!;
 const view=EditorView.findFromDOM(dom)!;
 expect(document.activeElement).toBe(view.contentDOM);
 expect(outgoing.at(-1).value.message).toMatchObject({botling:'hostObservation',chatId:bot.id,revision:1});
 // These are editor operations, not simulated OS keystrokes. Main's separate test checks native
 // focus before reveal; jsdom cannot establish Electron/macOS keyboard routing.
 view.dispatch(view.state.replaceSelection('n'));
 view.dispatch(view.state.replaceSelection('ab'));
 view.dispatch({selection:{anchor:2}});
 listeners.get(EDITOR_CHANNEL.down)!({}, {stamp,message:{botling:'plugins',specs:[{name:'local-plugin',version:'1',source:'synthetic',styles:[],settings:{},commands:[]}]}});
 await Promise.resolve();await Promise.resolve();
 const key=new KeyboardEvent('keydown',{key:'F2',bubbles:true,cancelable:true});
 view.contentDOM.dispatchEvent(key);
 expect(view.state.doc.toString()).toBe('naXb');
 expect(key.defaultPrevented).toBe(true);
 const selection=view.state.selection.main.head;
 // A real shell field choice stays authoritative across streamed business state.
 const field=document.createElement('input');document.body.append(field);field.focus();
 state();
 expect(document.activeElement).toBe(field);
 expect(EditorView.findFromDOM(dom)).toBe(view);
 expect(view.state.selection.main.head).toBe(selection);
 listeners.get(EDITOR_CHANNEL.unbound)!({},stamp);
 expect(bridge.post({botling:'stop'})).toBe(false);
 const fresh={...stamp,documentGeneration:'replacement'};
 listeners.get(EDITOR_CHANNEL.bound)!({},fresh);
 listeners.get(EDITOR_CHANNEL.down)!({}, {stamp:fresh,message:{botling:'state',...payload}});
 expect(document.activeElement).toBe(field);
 expect(EditorView.findFromDOM(dom)).toBe(view);
 expect(view.state.doc.toString()).toBe('naXb');
 expect(undo(view)).toBe(true);expect(redo(view)).toBe(true);
 expect(view.state.doc.toString()).toBe('naXb');
 const commandsBefore=outgoing.filter(({value})=>value.message?.action?.type==='shellCommand').length;
 const imeShortcut=new KeyboardEvent('keydown',{key:',',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true});
 view.contentDOM.dispatchEvent(imeShortcut);
 expect(outgoing.filter(({value})=>value.message?.action?.type==='shellCommand')).toHaveLength(commandsBefore);
 const shortcut=new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true});
 view.contentDOM.dispatchEvent(shortcut);
 expect(shortcut.defaultPrevented).toBe(true);
 expect(outgoing.at(-1).value.message).toEqual({botling:'action',action:{type:'shellCommand',command:'search'}});
 expect(parentPost).not.toHaveBeenCalled();
 view.destroy();delete (window as any).botlingEditor;
});
