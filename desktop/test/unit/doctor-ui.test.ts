// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";

it("offers Doctor in Settings and checks CLI health when opened", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  const root = createRoot(host);
  const request = vi.fn((cmd: { type: string }) => cmd.type === "settings.get" ? new Promise(() => {}) : Promise.resolve({ checks: [], isRunning: false, checkedAt: null, includedLatest: false, needsAttention: false }));
  const client = { request, onEvent: () => () => {} } as unknown as Client;
  try {
    await act(async () => root.render(createElement(SettingsSheet, { client, settings: null, bot: null, plugins: null, onClose() {} })));
    const tab = [...host.querySelectorAll("button")].find(button => button.textContent === "Doctor");
    expect(tab, "1.x Settings → Doctor must be reachable").toBeDefined();
    await act(async () => tab!.click());
    expect(request).toHaveBeenCalledWith({ type: "doctor.run", includeLatest: true });
    expect(host.textContent).toContain("Command-line tools");
  } finally {
    await act(async () => root.unmount());
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

import { DoctorSection } from "../../src/renderer/Doctor";
import { SidebarSettings } from "../../src/renderer/SidebarSettings";
import type { DoctorView, EventEnvelope } from "../../src/contract";

const checked = (attention = true): DoctorView => ({
  checks: [
    { tool: "claude", name: "Claude Code", isRequired: true, minimum: "2.1.111", status: attention ? "failing" : "ok", version: "2.1.304", path: "/u/bin/claude", auth: null, latest: null, summary: attention ? "Not signed in." : "Signed in with Claude subscription (pro).", fix: attention ? "'/u/bin/claude' auth login" : null },
    { tool: "codex", name: "Codex", isRequired: false, minimum: "0.99.0", status: "warning", version: null, path: null, auth: null, latest: null, summary: "Not found. It is optional.", fix: "npm i -g @openai/codex@latest" },
  ], isRunning: false, checkedAt: 1000, includedLatest: true, needsAttention: attention,
});

it("shows CLI status/minimum/path and copies repair commands without executing them; reruns disable the action", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  const value = checked();
  let finish!: (value: DoctorView) => void;
  let listener!: (event: EventEnvelope) => void;
  const off = vi.fn();
  const request = vi.fn((cmd: { type: string }) => cmd.type === "doctor.run" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(cmd.type === "doctor.copy" ? { copied: true } : value));
  const client = { request, onEvent: (fn: typeof listener) => { listener = fn; return off; } } as unknown as Client;
  try {
    await act(async () => root.render(createElement(DoctorSection, { client })));
    expect(request.mock.calls.map(call => call[0])).toEqual([{ type: "doctor.view" }]);
    expect(host.textContent).toContain("Claude Code2.1.304needs 2.1.111+");
    expect(host.textContent).toContain("/u/bin/claude");
    expect(host.querySelector('[aria-label="Failing"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Warning"]')).not.toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Copy")!.click());
    expect(request).toHaveBeenCalledWith({ type: "doctor.copy", tool: "claude" });
    expect(host.textContent).toContain("Copied");
    const again = [...host.querySelectorAll("button")].find(button => button.textContent === "Run again")!;
    await act(async () => again.click());
    expect(again.disabled).toBe(true);
    expect(request).toHaveBeenCalledWith({ type: "doctor.run", includeLatest: true });
    await act(async () => finish({ ...checked(false), checkedAt: 2000 }));
    expect(again.disabled).toBe(false);
    expect(host.querySelector('[aria-label="OK"]')).not.toBeNull();
    expect(host.textContent).not.toContain("auth login");
    await act(async () => listener({ event: { type: "doctor.updated", doctor: checked() } } as EventEnvelope));
    expect(host.textContent).toContain("Not signed in.");
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount()); expect(off).toHaveBeenCalledOnce();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("recovers a failed page check with Run again", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  const request = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue(checked(false));
  const client = { request, onEvent: () => () => {} } as unknown as Client;
  try {
    await act(async () => root.render(createElement(DoctorSection, { client })));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("could not finish");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Run again")!.click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("Signed in with Claude subscription (pro).");
  } finally {
    await act(async () => root.unmount());
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("shows the gear warning and Doctor shortcut only for required failure, in both rail sizes", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const client = { request: vi.fn(async () => ({})), onEvent: () => () => {} } as unknown as Client;
  const onOpen = vi.fn();
  try {
    for (const compact of [false, true]) {
      await act(async () => root.render(createElement(SidebarSettings, { client, compact, settings: null, plugins: null, doctor: checked(), settingsOpen: false, onOpen })));
      expect(host.querySelector('.doctor-dot[aria-label="Claude Code needs attention"]')).not.toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!.click());
      const shortcut = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Claude Code needs attention"));
      expect(shortcut).toBeDefined();
      await act(async () => shortcut!.click());
      expect(onOpen).toHaveBeenLastCalledWith("doctor");
      await act(async () => root.render(createElement(SidebarSettings, { client, compact, settings: null, plugins: null, doctor: checked(false), settingsOpen: false, onOpen })));
      expect(host.querySelector(".doctor-dot")).toBeNull();
    }
  } finally {
    await act(async () => root.unmount()); host.remove();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

it("keeps the startup rows visible while checking npm and shares the running indicator", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"), root = createRoot(host);
  let finish!: (value: DoctorView) => void;
  const request = vi.fn((cmd: { type: string }) => cmd.type === "doctor.run" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...checked(), includedLatest: false }));
  const client = { request, onEvent: () => () => {} } as unknown as Client;
  try {
    await act(async () => root.render(createElement(DoctorSection, { client })));
    expect(request).toHaveBeenCalledWith({ type: "doctor.run", includeLatest: true });
    expect(host.textContent).toContain("Not signed in.");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect([...host.querySelectorAll("button")].find(button => button.textContent === "Run again")?.disabled).toBe(true);
    await act(async () => finish(checked(false)));
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  }
});
it('installs Antigravity only on click, displays pending/failure, and permits retry', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'), root = createRoot(host);
  const view = checked(false);
  view.checks.push({tool:'antigravity',name:'Antigravity',isRequired:false,minimum:'1.4.3',status:'warning',version:null,path:null,auth:null,latest:null,summary:'Not configured.',fix:null});
  let reject!: (error: Error) => void;
  const request = vi.fn((cmd: {type:string}) => cmd.type === 'agy.runtime.install' ? new Promise((_resolve, failure) => {reject=failure;}) : Promise.resolve(view));
  const client = {request,onEvent:()=>()=>{}} as unknown as Client;
  try {
    await act(async () => root.render(createElement(DoctorSection,{client})));
    expect(request).not.toHaveBeenCalledWith({type:'agy.runtime.install'});
    const install = [...host.querySelectorAll('button')].find(b=>b.textContent==='Install locally and configure')!;
    await act(async () => install.click());
    expect(request).toHaveBeenCalledWith({type:'agy.runtime.install'});
    expect(install.disabled).toBe(true);
    await act(async () => reject(Error('archive hash mismatch')));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('archive hash mismatch');
    expect(install.disabled).toBe(false);
    await act(async () => install.click());
    expect(request.mock.calls.filter(([cmd])=>cmd.type==='agy.runtime.install')).toHaveLength(2);
  } finally { await act(async()=>root.unmount()); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=false; }
});
