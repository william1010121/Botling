// A `composerBar` view's frames sit in the chat page, which passes what they post to the app page
// (ComposerBar.ts `relayBroker`): the app page answers them as any plugin frame of its own, and the
// replies go back to the frame that asked.
import { expect, it, vi } from "vitest";
import { relayBroker } from "../../src/renderer/ComposerBar";
import { registerPluginFrame } from "../../src/renderer/frame-broker";

it("answers a relayed frame's call for its own plugin, back to that frame; refuses another plugin's command", async () => {
  const sent: { frame: string; data: unknown }[] = [];
  const relay = relayBroker((frame, data) => sent.push({ frame, data }));
  const call = vi.fn(async (plugin: string, method: string) => `${plugin}:${method}`);
  const command = vi.fn(async () => null);
  for (const which of ["compact", "expanded"] as const) registerPluginFrame(relay.broker, { call, command }, { frame: relay.frames[which], plugin: "usage" });
  relay.deliver("expanded", { ccb: "call", id: 7, method: "usage.read", params: null });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  expect(call).toHaveBeenCalledWith("usage", "usage.read", null);
  expect(sent[0]).toEqual({ frame: "expanded", data: { ccb: "reply", id: 7, ok: true, value: "usage:usage.read" } });
  relay.deliver("compact", { ccb: "command", id: "other.steal" });
  expect(command).not.toHaveBeenCalled();
  expect(relay.broker.refusals.at(-1)?.reason).toContain("another plugin");
});
