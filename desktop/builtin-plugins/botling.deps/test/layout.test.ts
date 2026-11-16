// The graph's layout: which plugins are drawn, in which column, and the arrows between the boxes.
import { describe, expect, it } from "vitest";
import type { DepBoard, DepNode } from "../../../../Web/host/src/api";
import { COL_GAP, layoutGraph, missingId, NODE_W, PAD } from "../src/layout";

const node = (name: string, more: Partial<DepNode> = {}): DepNode => ({
  name, title: name, version: "1.0.0", enabled: true, builtIn: true, failure: null, app: false, declared: true,
  provides: { services: [], slots: [] }, requires: [], uses: [], fills: [], features: [], ...more,
});
const board = (plugins: DepNode[], edges: DepBoard["edges"] = [], missing: DepBoard["missing"] = []): DepBoard => ({ plugins, edges, missing, slots: [], featureAreas: [] });
const edge = (from: string, to: string, service = "s", kind: "requires" | "uses" = "requires", live = true) => ({ from, to, service, kind, live });

describe("layoutGraph", () => {
  it("draws only plugins with an arrow: the rest are on the list, not in the graph", () => {
    expect(layoutGraph(board([node("a"), node("b")]))).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
    const graph = layoutGraph(board([node("a"), node("b"), node("lonely")], [edge("a", "b")]));
    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("puts whoever provides in the column to the right of whoever needs it, chains going further left", () => {
    const graph = layoutGraph(board([node("app"), node("mid"), node("base")], [edge("app", "mid"), edge("mid", "base"), edge("app", "base", "t")]));
    const x = (id: string) => graph.nodes.find((n) => n.id === id)!.x;
    expect(x("app")).toBe(PAD);
    expect(x("mid")).toBe(PAD + NODE_W + COL_GAP);
    expect(x("base")).toBe(PAD + 2 * (NODE_W + COL_GAP));
    expect(graph.width).toBe(PAD * 2 + 3 * NODE_W + 2 * COL_GAP);
    // Each arrow runs from the right side of the needing box to the left side of the providing one.
    const first = graph.edges.find((e) => e.from === "app" && e.to === "mid")!;
    expect(first.path.startsWith(`M ${PAD + NODE_W} `)).toBe(true);
    expect(first.path.endsWith(` ${x("mid")} ${graph.nodes.find((n) => n.id === "mid")!.y + 23}`)).toBe(true);
  });

  it("keeps the kind and whether it is live; a dashed (uses) arrow to a plugin that is off is not live", () => {
    const graph = layoutGraph(board([node("a"), node("b", { enabled: false })], [edge("a", "b", "svc", "uses", false)]));
    expect(graph.edges).toEqual([expect.objectContaining({ kind: "uses", live: false, service: "svc" })]);
    expect(graph.nodes.find((n) => n.id === "b")).toMatchObject({ enabled: false, sub: "v1.0.0 · off" });
  });

  it("a missing provider is a red stand-in box at the right end, with a red arrow", () => {
    const graph = layoutGraph(board([node("needs")], [], [{ plugin: "needs", service: "ghost.svc", offProviders: [] }]));
    expect(graph.nodes.map((n) => [n.id, n.kind, n.sub])).toEqual([["missing:ghost.svc", "missing", "no provider"], ["needs", "plugin", "v1.0.0"]]);
    expect(graph.nodes.find((n) => n.id === missingId("ghost.svc"))!.x).toBeGreaterThan(graph.nodes.find((n) => n.id === "needs")!.x);
    expect(graph.edges).toEqual([expect.objectContaining({ kind: "missing", from: "needs", to: "missing:ghost.svc", service: "ghost.svc" })]);
  });

  it("the app's own page is a box of its own kind; one service two plugins lack is one box", () => {
    const graph = layoutGraph(board([node("botling.chat", { app: true, version: "" }), node("x"), node("y")], [edge("x", "botling.chat", "q", "uses")],
      [{ plugin: "x", service: "g", offProviders: [] }, { plugin: "y", service: "g", offProviders: [] }]));
    expect(graph.nodes.find((n) => n.id === "botling.chat")).toMatchObject({ kind: "app", sub: "built in" });
    expect(graph.nodes.filter((n) => n.kind === "missing")).toHaveLength(1);
    expect(graph.edges.filter((e) => e.kind === "missing")).toHaveLength(2);
  });

  it("a cycle ends (each box still gets a column) and an arrow to a plugin the board does not list is left out", () => {
    const graph = layoutGraph(board([node("a"), node("b")], [edge("a", "b"), edge("b", "a", "t"), edge("a", "ghost", "u")]));
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(graph.edges).toHaveLength(2);
    expect(Number.isFinite(graph.width) && Number.isFinite(graph.height)).toBe(true);
  });

  it("two services between the same two plugins are two arrows", () => {
    const graph = layoutGraph(board([node("a"), node("b")], [edge("a", "b", "one"), edge("a", "b", "two")]));
    expect(graph.edges.map((e) => e.service)).toEqual(["one", "two"]);
    expect(new Set(graph.edges.map((e) => e.id)).size).toBe(2);
  });
});
