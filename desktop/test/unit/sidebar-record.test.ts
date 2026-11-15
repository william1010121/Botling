// @vitest-environment jsdom
// TEMPORARY (M7-05a): records the left column's markup of the code before the rail moved into the sidebar plugin; its output is
// printed between @@GOLDEN and @@END lines and copied into test/fixtures/sidebar/. Removed in the next commit.
import { act } from "react";
import { afterEach, describe, it, vi } from "vitest";
import { ID, mountPage, NOW, type MountedPage } from "../sidebar-page";

const pages: MountedPage[] = [];
afterEach(async () => { for (const page of pages.splice(0)) await page.unmount(); localStorage.clear(); vi.useRealTimers(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
const emit = (name: string, markup: string) => process.stdout.write(`@@GOLDEN ${name}\n${markup}\n@@END\n`);

async function page(options: Parameters<typeof mountPage>[0]) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const mounted = await mountPage(options);
  pages.push(mounted);
  return mounted;
}

describe("record", () => {
  it("pinned", async () => { emit("pinned", (await page({ settings: { pinnedBots: [ID.beta, ID.gamma] }, shown: ID.alpha })).rail()); });
  it("idle", async () => { emit("idle", (await page({ settings: { pinnedBots: [ID.beta], idleBots: [ID.delta, ID.gamma] } })).rail()); });
  it("idle-open", async () => {
    const mounted = await page({ settings: { pinnedBots: [ID.beta], idleBots: [ID.delta, ID.gamma] } });
    await act(async () => { (mounted.host.querySelector(".rail-idle-row") as HTMLButtonElement).click(); });
    emit("idle-open", mounted.rail());
  });
  it("folded", async () => { emit("folded", (await page({ settings: { railCollapsed: true, pinnedBots: [ID.beta], idleBots: [ID.delta] } })).rail()); });
  it("subbots", async () => { emit("subbots", (await page({ shown: ID.sub })).rail()); });
});
