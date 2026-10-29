// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it } from 'vitest';
import { BotSettings } from '../../src/renderer/Settings';
import type {Client} from '../../src/renderer/client';
import type {BotView} from '../../src/contract';
it('loads discovered choices, keeps unavailable IDs, retries, and saves only explicit selections',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),calls:any[]=[];
 let state:any={botId:'main',engines:['claude','codex','agy'],model:'custom-claude',subagentModel:'saved-subagent',codexModel:'retired',agyModel:null,effort:'medium'};
 let resolveAgy:(value:any)=>void=()=>{};let agyCalls=0;
 const client={request:async(cmd:any)=>{
  calls.push(cmd);
  if(cmd.type==='bot.settings')return state;
  if(cmd.type==='bot.configure'){state={...state,...cmd};return state;}
  if(cmd.type==='engine.models'){
   if(cmd.engine==='agy'&&++agyCalls===1)return new Promise(resolve=>{resolveAgy=resolve;});
   return {status:'ready',source:cmd.engine==='agy'?'Antigravity ACP session/new':'Claude Code initialization',message:'Catalog',models:[{id:'discovered',name:'Discovered model',isDefault:true,efforts:null}]};
  }
 }} as unknown as Client;
 const select=(label:string)=>host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
 const choose=async(label:string,value:string)=>act(async()=>{const e=select(label);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));});
 try {
  await act(async()=>root.render(createElement(BotSettings,{client,bot:{id:'main',heads:state.engines,phase:'asleep'} as BotView})));
  expect(host.textContent).toContain('Loading models');expect(select("Claude's model").value).toBe('custom-claude');expect(select("Claude subagents' model").value).toBe('saved-subagent');
  expect(host.textContent).toContain('not in the current list');expect(calls.filter(c=>c.type==='bot.configure')).toEqual([]);
  expect(calls.filter(c=>c.type==='engine.models'&&c.engine==='claude')).toHaveLength(1);
  await act(async()=>resolveAgy({status:'signed-out',models:[],source:'Antigravity ACP',message:'ACP requires sign-in.'}));
  expect(host.textContent).toContain('ACP requires sign-in');expect(select('Antigravity model').value).toBe('');
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Refresh Antigravity model"]')!.click());
  expect(select('Antigravity model').options.length).toBe(2);
  await choose('Antigravity model','discovered');expect(calls.at(-1)).toEqual({type:'bot.configure',botId:'main',agyModel:'discovered'});
  await choose("Claude's model",'discovered');await choose("Claude subagents' model",'discovered');await choose("Codex's model",'');
  expect(state).toMatchObject({model:'discovered',subagentModel:'discovered',codexModel:null,effort:'medium',engines:['claude','codex','agy']});
 } finally {await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});

it('ignores discovery responses from a previously selected bot',async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let finishOld:(value:any)=>void=()=>{};
 const client={request:async(cmd:any)=>{
  if(cmd.type==='bot.settings')return {botId:cmd.botId,engines:['codex'],model:null,subagentModel:null,agyModel:null,codexModel:cmd.botId+'-saved',effort:null};
  if(cmd.botId==='old')return new Promise(resolve=>{finishOld=resolve;});
  return {status:'ready',source:'Codex',message:'',models:[{id:'new-model',name:'New model',isDefault:false,efforts:null}]};
 }} as unknown as Client;
 const render=(id:string)=>root.render(createElement(BotSettings,{client,bot:{id,heads:['codex'],phase:'asleep'} as BotView}));
 try {
  await act(async()=>render('old'));await act(async()=>render('new'));
  await act(async()=>finishOld({status:'ready',source:'Codex',message:'',models:[{id:'old-model',name:'Old model',isDefault:false,efforts:null}]}));
  const select=host.querySelector<HTMLSelectElement>('select[aria-label="Codex\'s model"]')!;
  expect(select.value).toBe('new-saved');expect([...select.options].map(o=>o.value)).toEqual(['','new-saved','new-model']);
 }finally{await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
