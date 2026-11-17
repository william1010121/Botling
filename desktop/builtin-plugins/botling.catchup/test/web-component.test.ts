// @vitest-environment jsdom
// What the viewer's live component draw hands the chat page (src/web.ts): the stored data only, built at once.
import { describe, expect, it, vi } from "vitest";
import type { CcbWeb } from "../../../../Web/src/plugins";
import type { DisplayView } from "../../../../Web/src/types";
import { activate } from "../src/web";
import { page } from "../src/page";

describe("web part: page.component", () => {
  const info = { template: "<p>x</p>", version: 1, working: false, updated: false, hasPrevious: false };
  const display: DisplayView = { name: "inline-chart", data: '{"a":1}', command: "touch /tmp/never-run", folder: "/tmp", detail: "touch /tmp/never-detail", card: "c1", every: 1, images: { "/p.png": "u" } };

  it("draws through ccb.draw.component with no command, no Detail, no folder, no card, and not lazily (a lazy frame outside the chat's scroller is never built)", () => {
    const drawn = vi.fn(() => document.createElement("div"));
    const ccb = { messages: { render: (s: string) => s, media: () => "" }, decorations: { register: () => () => {} }, draw: { component: drawn }, call: async () => null } as unknown as CcbWeb;
    const stop = activate(ccb);
    try {
      const result = page.component("inline-chart", info, display, "m1/source-0");
      expect(result).toBeInstanceOf(HTMLElement);
      expect(drawn).toHaveBeenCalledTimes(1);
      const spec = (drawn.mock.calls[0] as unknown as [Record<string, any>])[0];
      expect(spec.lazy).toBe(false);
      expect(spec.display).toMatchObject({ name: "inline-chart", data: '{"a":1}', command: null, detail: null, folder: null, card: null, images: { "/p.png": "u" } });
      expect(spec.key).toBe("m1/source-0");
      expect(spec).not.toHaveProperty("send");
      // The display it was given is not changed (the chat's own message keeps its command).
      expect(display.command).toBe("touch /tmp/never-run");
    } finally { stop(); }
  });
});
