// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TokenFlowCanvas } from "../../src/renderer/TokenFlowCanvas";
import { flowWorkers } from "../../src/renderer/token-flow-model";
import * as layout from "../../src/renderer/token-flow-layout";
import type { BotView } from "../../src/contract";

const bot = { id: "bot", name: "Main", working: true, heads: ["codex"], subagentRows: [], delegationRows: [
  { id: "parent", parentId: null, title: "Parent", head: "codex", status: "running", outputTokens: 120, startedAt: 0, endedAt: null },
  { id: "child", parentId: "parent", title: "Child", head: "codex", status: "completed", outputTokens: 20, startedAt: 0, endedAt: null },
  { id: "orphan", parentId: "missing", title: "Missing parent", head: "codex", status: "stopped", outputTokens: null, startedAt: 0, endedAt: null },
] } as unknown as BotView;

it("drags nodes, pans, zooms, fits and keeps user positions across token updates and arrivals", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const initial = flowWorkers(bot, []), ids = ["coordinator", ...initial.map(node => node.key)];
  const arranged = layout.addPositions({}, ids);
  const arrange = vi.spyOn(layout, "layoutFlow").mockResolvedValue(arranged);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500, toJSON() {} });
  localStorage.clear();
  const host = document.createElement("div"); document.body.append(host); let root = createRoot(host);
  const select = vi.fn();
  const render = async (value = bot) => act(async () => root.render(createElement(TokenFlowCanvas, { bot: value, workers: flowWorkers(value, []), selected: null, onSelect: select })));
  const pointer = (element: Element, type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 }); element.dispatchEvent(event);
  };
  const position = (node: HTMLElement) => node.dataset.position!.split(",").map(Number);
  const camera = () => host.querySelector<HTMLElement>(".tf-world")!.dataset.camera!.split(",").map(Number);
  try {
    await render();
    const canvas = host.querySelector<HTMLElement>(".tf-canvas")!;
    let child = [...host.querySelectorAll<HTMLElement>("[data-flow-node]")].find(node => node.textContent?.includes("Child"))!;
    const old = position(child), scale = camera()[2];
    expect(host.querySelectorAll(".tf-edges > path")).toHaveLength(2);
    const edges = [...host.querySelectorAll<SVGElement>(".tf-edges > path")].map(path => [path.dataset.source, path.dataset.target]);
    expect(edges).toContainEqual([initial[0].key, initial[1].key]);
    expect(edges.some(edge => edge[1] === initial[2].key)).toBe(false);
    await act(async () => { pointer(child, "pointerdown", 200, 100); pointer(canvas, "pointermove", 280, 140); pointer(canvas, "pointerup", 280, 140); });
    expect(position(child)[0]).toBeCloseTo(old[0] + 80 / scale);
    expect(position(child)[1]).toBeCloseTo(old[1] + 40 / scale);
    expect(select).not.toHaveBeenCalled();
    const moved = position(child);
    const updated = { ...bot, delegationRows: [...bot.delegationRows!.map(row => ({ ...row, outputTokens: 999 })), { ...bot.delegationRows![1], id: "new-child" }] };
    await render(updated);
    expect(position(child)).toEqual(moved);
    await render({ ...bot, delegationRows: bot.delegationRows!.filter(row => row.id !== "child") });
    await render(updated);
    expect(position([...host.querySelectorAll<HTMLElement>("[data-flow-node]")].find(node => node.dataset.flowNode === initial[1].key)!)).toEqual(moved);
    expect(arrange).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll("[data-flow-node]")).toHaveLength(5);
    child = [...host.querySelectorAll<HTMLElement>("[data-flow-node]")].find(node => node.dataset.flowNode === initial[1].key)!;
    const beforePan = camera();
    await act(async () => { pointer(canvas, "pointerdown", 10, 10); pointer(canvas, "pointermove", 60, 40); pointer(canvas, "pointerup", 60, 40); });
    expect(camera().slice(0, 2)).toEqual([beforePan[0] + 50, beforePan[1] + 30]);
    const beforeZoom = camera()[2];
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(camera()[2]).toBeCloseTo(beforeZoom * 1.2);
    const beforeWheel = camera();
    await act(async () => canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 400, clientY: 250 })));
    expect(camera()[2]).toBeGreaterThan(beforeWheel[2]);
    const fit = host.querySelector<HTMLButtonElement>('[aria-label="Fit view"]')!;
    await act(async () => fit.click());
    const [x, y, zoom] = camera();
    for (const node of host.querySelectorAll<HTMLElement>("[data-flow-node]")) {
      const [nx, ny] = position(node);
      expect(nx * zoom + x).toBeGreaterThanOrEqual(0);
      expect(ny * zoom + y).toBeGreaterThanOrEqual(0);
      expect((nx + layout.NODE_WIDTH) * zoom + x).toBeLessThanOrEqual(800);
      expect((ny + layout.NODE_HEIGHT) * zoom + y).toBeLessThanOrEqual(500);
    }
    await act(async () => { pointer(child, "pointerdown", 200, 100); pointer(canvas, "pointercancel", 200, 100); pointer(canvas, "pointermove", 800, 400); });
    expect(position(child)).toEqual(moved);
    await act(async () => child.click());
    expect(select).toHaveBeenCalledWith(initial[1].key);
    const savedCamera = camera();
    await act(async () => root.unmount()); root = createRoot(host); await render(updated);
    expect(camera()).toEqual(savedCamera);
    expect([...host.querySelectorAll<HTMLElement>("[data-flow-node]")].find(node => node.dataset.flowNode === initial[1].key)!.dataset.position).toBe(moved.join(","));
  } finally { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
