// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it } from 'vitest';
import { BotSettings } from '../../src/renderer/Settings';
import type { Client } from '../../src/renderer/client';
import type { BotView } from '../../src/contract';
it('switches to agy alone, saves a model ID and shows capability limits',async()=>{
 const calls:any[]=[];let view:any={botId:'main',engines:['claude'],model:null,effort:null,subagentModel:null,codexModel:null,agyModel:null};
 const client={request:async(cmd:any)=>{calls.push(cmd);if(cmd.type==='heads.set')view={...view,engines:cmd.engines};if(cmd.type==='bot.configure')view={...view,...cmd};return view;}} as unknown as Client;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 try{
  await act(async()=>root.render(createElement(BotSettings,{client,bot:{id:'main',heads:['claude'],phase:'asleep'} as BotView})));
  await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="Antigravity"]')!.click());
  expect(calls.find(c=>c.type==='heads.set')).toMatchObject({engines:['agy']});
  expect(host.textContent).toContain('Tools requiring approval are refused');
  expect(host.querySelector('[aria-label="Claude\'s model"]')).toBeNull();
  const input=host.querySelector<HTMLInputElement>('[aria-label="Antigravity model"]')!;
  await act(async()=>{input.value='gemini-3.8-flash-medium';input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));});
  expect(calls.find(c=>c.type==='bot.configure')).toMatchObject({agyModel:'gemini-3.8-flash-medium'});
  await act(async()=>host.querySelector<HTMLInputElement>('[aria-label="Codex"]')!.click());
  expect(calls.filter(c=>c.type==='heads.set').at(-1)).toMatchObject({engines:['codex']});
 }finally{await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
