// Who may send an `approve`-scope request (M7-06a, decision Q-M7-C5, plan-change C5): the chat draws tool-approval cards and is a plugin
// now. A plugin's request goes DIRECT only when its name and code hash are a pair in the FE-build manifest (trusted: the page's own
// bundle shipped that code, `botling.chat`); every other plugin, a framed third party, a changed hash, or no known plugin goes through
// the shell's approval sheet (`ApprovalSheet.tsx`), as spec model `approval` says. The device scope applies on top of both (the core).
// Pure; a check that cannot tell fails closed (the sheet). M7-07b calls it where the chat plugin's card answer is sent.
import { embeddedFeManifest, type FeManifest } from "./inpage-loader";

export type ApproveRoute = "direct" | "sheet";

export function approveRoute(source: { name: string; codeHash: string } | null | undefined, manifest: FeManifest = embeddedFeManifest()): ApproveRoute {
  if (!source || typeof source.name !== "string" || typeof source.codeHash !== "string") return "sheet";
  return manifest.plugins.some((entry) => entry.name === source.name && entry.codeHash === source.codeHash) ? "direct" : "sheet";
}
