// @vitest-environment jsdom
import { act,createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it } from 'vitest';
import { BotSettings } from '../../src/renderer/Settings';
import type { Client } from '../../src/renderer/client';
import type { BotView } from '../../src/contract';
it('shows Antigravity as unavailable without sending a selection request',async()=>{
 const calls:any[]=[];
 const client={request:async(cmd:any)=>{calls.push(cmd);return {botId:'main',engines:['claude']};}} as unknown as Client;
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 try {
 await act(async()=>root.render(createElement(BotSettings,{client,bot:{id:'main',heads:['claude'],phase:'asleep'} as BotView})));
 const input=host.querySelector<HTMLInputElement>('[aria-label="Antigravity"]')!;
 expect(input.disabled).toBe(true);await act(async()=>input.click());expect(calls.some(c=>c.type==='heads.set')).toBe(false);
 } finally {await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
