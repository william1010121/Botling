// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TokenFlowCanvas } from '../../src/renderer/TokenFlowCanvas';
import { historicalAllocation } from '../../src/renderer/token-flow-history-model';
import type { BotView } from '../../src/contract';

// Screenshot topology: five task groups, four purposes (including an empty Mixed).
import { records } from "../fixtures/token-flow/readable-data";

it('keeps screenshot allocation in semantic columns despite stale mixed positions, updates and narrow screens', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const bot = { id: 'readable', name: 'botling' } as BotView;
  const allocation = historicalAllocation(records, 'all', Date.now());
  const ids = ['coordinator', ...allocation.nodes.map(n => n.key)];
  const mixed = Object.fromEntries(ids.map((id, i) => [id, { x: i % 3 * 290, y: Math.floor(i / 3) * 160 }]));
  localStorage.setItem('token-flow-layout-v2', JSON.stringify({ 'readable:wide': { positions: mixed, camera: { x: 24, y: 24, scale: 1 } } }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const selected: string[] = [];
  const render = async (nodes = allocation.nodes) => act(async () => root.render(createElement(TokenFlowCanvas, { bot, workers: nodes, allocationEdges: allocation.edges, rootOutput: allocation.known, rootLabel: 'All available · partial', basis: 'tokens', selected: null, onSelect: key => { if (key) selected.push(key); } })));
  const positions = () => Object.fromEntries([...host.querySelectorAll<HTMLElement>('[data-flow-node]')].map(n => [n.dataset.flowNode!, n.dataset.position!.split(',').map(Number)]));
  try {
    await render();
    const before = positions();
    expect(new Set(allocation.nodes.filter(n => n.key.startsWith('group:')).map(n => before[n.key][0])).size).toBe(1);
    expect(new Set(allocation.nodes.filter(n => n.key.startsWith('purpose:')).map(n => before[n.key][0])).size).toBe(1);
    for (const edge of allocation.edges) expect(before[edge.target][0]).toBeGreaterThan(before[edge.source][0] + 220);
    expect(host.textContent).toContain('Project'); expect(host.textContent).toContain('Tasks'); expect(host.textContent).toContain('Activity');
    expect(host.querySelector('[data-flow-node="purpose:mixed"]')?.textContent).toContain('—');
    expect(host.querySelector('[data-flow-node="coordinator"]')?.textContent).toContain('partial');
    await render([...allocation.nodes].reverse().map(n => ({ ...n, output: n.output === null ? null : n.output + 1 })));
    expect(positions()).toEqual(before);
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(positions()).toEqual(before);
    const scrollTo = vi.fn();
    Object.defineProperty(host.querySelector('.tf-canvas'), 'scrollTo', { value: scrollTo });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Show Activity column"]')!.click());
    expect(scrollTo).toHaveBeenCalledWith({ left: 680, top: 0 });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-flow-node="group:task:chat"]')!.click());
    expect(selected).toEqual(['group:task:chat']);
  } finally { await act(async () => root.unmount()); host.remove(); localStorage.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
