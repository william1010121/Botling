// @vitest-environment jsdom
// When the shell's host refused the sidebar plugin (a pair the build's manifest does not list: the shell's trusted loader says no), the
// left column is not a blank page and not a stale list: it is the shell's one "unavailable" line (M7-05a; the same rule as Settings, M7-02c).
// A separate file: a refusal marks the renderer's singleton host for the rest of the file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { inPageHost } from "../../src/renderer/shell/inpage-host";
import { SIDEBAR_PLUGIN } from "../../src/renderer/sidebar-names";
import { ID, mountPage, NOW, type MountedPage } from "../sidebar-page";

const pages: MountedPage[] = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
  vi.useRealTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("the sidebar refused by the shell's host", () => {
  it("shows 'The sidebar is unavailable.' in the column's place, not the bots, and the rest of the page is still drawn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const [result] = await inPageHost.start([{ name: SIDEBAR_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(result?.status).toBe("refused");
    expect(inPageHost.unavailable(SIDEBAR_PLUGIN)).toBe(true);
    const mounted = await mountPage({ shown: ID.alpha, settings: { pinnedBots: [ID.beta] } });
    pages.push(mounted);
    const rail = mounted.host.querySelector("aside.rail");
    expect(rail?.querySelector('p[role="status"]')?.textContent).toBe("The sidebar is unavailable.");
    expect(rail?.querySelector("nav.bots")).toBeNull();
    expect(mounted.host.querySelector(".chat-pane")).not.toBeNull();
    expect(mounted.host.querySelectorAll("aside.rail")).toHaveLength(1);
  });
});
