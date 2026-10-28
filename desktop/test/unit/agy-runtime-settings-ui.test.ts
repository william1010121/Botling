// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { SettingsSheet } from '../../src/renderer/Settings';
import { settingsView } from '../../src/core/settings';
import type { Client } from '../../src/renderer/client';
it('makes official Antigravity runtime configuration discoverable in Engines settings', async () => {
 const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 const client = { request: async () => ({ models: [] }) } as unknown as Client;
 try {
  await act(async () => root.render(createElement(SettingsSheet, { client, settings: settingsView({}), bot: null, plugins: null, initialSection: 'engines', onClose() {} })));
  expect(host.querySelector('input[aria-label="Official ACP runtime path"]')).not.toBeNull();
  expect(host.textContent).toContain('Save and verify');
 } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
it('keeps a rejected draft visible, saves a corrected path, and explains the environment override', async () => {
 const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
 const calls: any[] = [];
 let saved: string | null = null;
 const client = {request: async (cmd: any) => {
  calls.push(cmd);
  if (cmd.type === 'codex.models') return {models:[]};
  if (cmd.type === 'agy.runtime.check') return {saved,override:'/environment/runtime',effective:'/environment/runtime',valid:false,message:'Correct the environment override.'};
  if (cmd.type === 'settings.set') {
   if (cmd.change.value === 'bad') throw Error('Official runtime hash mismatch; choose ACP 1.4.3.');
   saved=cmd.change.value;return settingsView({agyAcpPath:saved});
  }
 }} as unknown as Client;
 const enter = async (value: string) => {
  await act(async () => {
   const input=host.querySelector<HTMLInputElement>('[aria-label="Official ACP runtime path"]')!;
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
   input.dispatchEvent(new Event('input',{bubbles:true}));
  });
 };
 const save = async () => {await act(async () => [...host.querySelectorAll('button')].find(b=>b.textContent==='Save and verify')!.click());};
 try {
  await act(async () => root.render(createElement(SettingsSheet,{client,settings:settingsView({}),bot:null,plugins:null,initialSection:'engines',onClose(){}})));
  expect(host.textContent).toContain('Environment override active: /environment/runtime');
  await enter('bad'); await save();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('hash mismatch');
  expect(host.querySelector<HTMLInputElement>('[aria-label="Official ACP runtime path"]')!.value).toBe('bad');
  expect(saved).toBeNull();
  await enter('/official/runtime'); await save();
  expect(saved).toBe('/official/runtime');
  expect(host.textContent).toContain('Environment override active: /environment/runtime');
  await enter(''); await save(); expect(saved).toBeNull();
  expect(calls.filter(c=>c.type==='settings.set')).toHaveLength(3);
 } finally {await act(async()=>root.unmount());host.remove();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;}
});
