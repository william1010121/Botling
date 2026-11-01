// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { settingsView } from "../../src/core/settings";
import { App } from '../../src/renderer/App';
import { Client } from '../../src/renderer/client';
import { WorkspaceStore } from '../../src/renderer/store';
import { ShellOverlay, shellPortal } from '../../src/renderer/ShellOverlay';
import { observeEditorLayout, postToChat } from '../../src/renderer/editor-surface';
import { editorBridge } from '../../src/preload/editor-bridge';
import { EDITOR_CHANNEL } from '../../src/editor-host-wire';
import { PROTOCOL_VERSION, type BotView, type ResultOf } from '../../src/contract';

const stamp={surfaceId:'surface',documentGeneration:'document'};
function nativeShell(){
 const listeners=new Map<string,Function>();const send=vi.fn();
 const bridge=editorBridge({on:(channel,fn)=>listeners.set(channel,fn),send},'shell');
 Object.defineProperty(window,'botling',{value:{editorHost:bridge},configurable:true});
 return{bridge,send,bind:()=>listeners.get(EDITOR_CHANNEL.bound)!({},stamp),
  receive:(message:unknown)=>listeners.get(EDITOR_CHANNEL.shell)!({}, {stamp,message})};
}
afterEach(()=>{delete (window as any).botling;document.body.innerHTML='';vi.restoreAllMocks();vi.unstubAllGlobals();});

it('retains a single native surface while dialogs, Web/hidden layout and resizing hide/restore it',async()=>{
 let resized=()=>{};
 vi.stubGlobal('ResizeObserver',class{constructor(fn:()=>void){resized=fn;}observe(){}disconnect(){}});
 const shell=nativeShell();
 const holder=document.createElement('div');document.body.append(holder);
 let box={x:220,y:80,width:640,height:650};
 vi.spyOn(holder,'getBoundingClientRect').mockImplementation(()=>box as DOMRect);
 const stop=observeEditorLayout(holder,shell.bridge,()=>true);
 expect(shell.send).not.toHaveBeenCalled();
 shell.bind();
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:box});
 const overlayHost=document.createElement('div');document.body.append(overlayHost);
 const root=createRoot(overlayHost);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 await act(async()=>root.render(shellPortal(createElement('aside',{style:{pointerEvents:'none'}},'Unnamed hover portal'))));
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:box,occluded:true});
 await act(async()=>root.render(createElement(ShellOverlay,null,createElement('article',null,'Custom expanded report'))));
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:box,occluded:true});
 await act(async()=>root.unmount());(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:box});
 box={...box,width:0,height:0};resized();
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:null});
 box={x:80,y:60,width:720,height:680};resized();
 expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:box});
 stop();expect(shell.send).toHaveBeenLastCalledWith(EDITOR_CHANNEL.layout,{stamp,bounds:null});
});

it('mounts App with a placeholder, routes state/send through the authenticated pair and never falls back to a second iframe while unbound',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 const shell=nativeShell();
 const bot:BotView={id:'main',name:'Main',role:'main',avatar:'square',folder:'/synthetic',phase:'awake',working:false,approvals:0,unread:0,subagents:0,problem:null,heads:['claude'],job:null,subagentRows:[]};
 const snapshot:ResultOf<'chat.snapshot'>={epoch:'test',seq:0,bots:[bot],imported:null,settings:settingsView({railCollapsed:true}),chat:{botId:bot.id,messages:[],running:null,live:[],tasks:[],runs:[],heads:null,catchUp:null,intervalSummaries:[],pins:[],floating:[],pinChoices:[]},components:{},plugins:{plugins:[],broken:[],host:{running:false,problem:null},secretsProblem:null}};
 const store=new WorkspaceStore(async()=>snapshot);await store.resync();
 const commands:any[]=[];let respond:(message:unknown)=>void=()=>{};
 const client=new Client({protocol:PROTOCOL_VERSION,subscribe(fn){respond=fn;return()=>{};},post(envelope:any){
  commands.push(envelope.cmd);
  queueMicrotask(()=>respond({v:PROTOCOL_VERSION,id:envelope.id,ok:true,result:envelope.cmd.type==='plugins.web'?{specs:[]}: {}}));
 }});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 try{
  await act(async()=>root.render(createElement(App,{client,store})));
  expect(host.querySelector('#chat-frame')?.tagName).toBe('DIV');
  expect(host.querySelector('iframe#chat-frame')).toBeNull();
  postToChat({botling:'focus'});expect(shell.send).not.toHaveBeenCalled();
  await act(async()=>shell.bind());
  expect(shell.send.mock.calls.some(([channel,packet])=>channel===EDITOR_CHANNEL.down&&packet.message.botling==='state'&&packet.message.state.botID===bot.id)).toBe(true);
  await act(async()=>shell.receive({botling:'action',action:{type:'send',text:'first n'}}));
  expect(commands).toContainEqual({type:'chat.send',botId:bot.id,text:'first n'});
  const count=commands.filter(cmd=>cmd.type==='chat.send').length;
  // postMessage cannot impersonate the native editor, including messages with a copied origin.
  window.dispatchEvent(new MessageEvent('message',{origin:'botling-chat://chat',source:window,data:{botling:'action',action:{type:'send',text:'forged'}}}));
  expect(commands.filter(cmd=>cmd.type==='chat.send')).toHaveLength(count);
  // A folded face's peek would be drawn under the native chat: it covers the chat while open, then gives it back.
  const face=host.querySelector<HTMLElement>('.strip-bot')!;
  await act(async()=>face.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})));
  expect(host.querySelector('.strip-peek')).not.toBeNull();
  expect(shell.send.mock.calls.at(-1)).toMatchObject([EDITOR_CHANNEL.layout,{occluded:true}]);
  await act(async()=>face.dispatchEvent(new MouseEvent('mouseout',{bubbles:true})));
  await act(async()=>new Promise(resolve=>setTimeout(resolve,300)));
  expect(host.querySelector('.strip-peek')).toBeNull();
  expect(shell.send.mock.calls.at(-1)?.[0]).toBe(EDITOR_CHANNEL.layout);
  expect(shell.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('occluded');
  await act(async()=>shell.receive({botling:'action',action:{type:'shellCommand',command:'settings'}}));
  expect(host.querySelector('.settings-backdrop')).not.toBeNull();
 }finally{await act(async()=>root.unmount());(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
