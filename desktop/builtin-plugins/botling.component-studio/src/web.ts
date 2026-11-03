// botling.component-studio's web part, in the chat page: draws the chips its program part put under replies (message decorations) and, in the
// chat page's panel mode (the right panel's page opened by `ui.takeover`), the spec workspace. What either asks goes to the program part
// (desk.ts, through `ccb.call`); a command that is not allowed yet asks for your OK on the app's own sheet (`ccb.requestApproval`), then runs.
import type { CcbWeb } from "../../../../Web/src/plugins";
import { chipRenderer, type ChipIO } from "./chips";
import { SpecPanel, type PanelIO } from "./panel";
import type { ComponentInfo, SpecState } from "./types";

/** The view id the manifest names (`contributes.views`). */
export const VIEW = "botling.component-studio.spec";

/** What a press or a panel action answers (`ActResult`). */
interface Acted { accepted?: boolean; needsApproval?: { command: string; folder: string; detail?: string | null; card?: string | null } }

export function activate(ccb: CcbWeb): () => void {
  const failed = (error: unknown) => ccb.notify(String((error as { message?: unknown } | null)?.message ?? error).slice(0, 400));
  const call = (method: string, params: Record<string, unknown> = {}) => ccb.call(method, params);
  const act = (method: string, params: Record<string, unknown> = {}) => { void call(method, params).catch(failed); };

  /** Asks the program part to run something; when it says that waits for your OK, the sheet asks (with the bot whose chat it is), and on Allow it asks again. */
  const allowed = async (chat: string, method: string, params: Record<string, unknown>) => {
    const first = (await call(method, params)) as Acted;
    const ask = first?.needsApproval;
    if (!ask) return;
    const answer = await ccb.requestApproval({ botId: chat, command: ask.command, folder: ask.folder, ...(ask.card ? { card: ask.card } : {}), ...(ask.detail ? { detail: ask.detail } : {}) });
    if (answer.allowed) await call(method, params);
  };

  const io: ChipIO = {
    press: (id) => act("press", { id }),
    open: (id) => act("open", { id }),
    undo: (id) => act("undo", { id }),
    restore: (id) => act("restore", { id }),
    run: (chat, id, request) => { void allowed(chat, "command", { id, ...request }).catch(failed); },
  };
  const disposers: (() => void)[] = [ccb.decorations.register(chipRenderer(ccb.draw, io))];

  // The right panel's page (panel mode): the open spec, pushed by the program part (`ui.emit`) and asked for when the page opens.
  disposers.push(ccb.panels.register(VIEW, (root) => {
    let chat = "";
    const panelIO: PanelIO = {
      act,
      testRun: (id, command, folder) => { void allowed(chat, "testRun", { id, command, folder }).catch(failed); },
      preview: (name, info, data, key) => ccb.draw.component({
        name, info: info as ComponentInfo, key, cardKey: key, lazy: false,
        display: { name, data, at: null, command: null, folder: null, detail: null, card: null, status: null, error: null, ranAt: null, images: null, pinned: null, every: null },
      }),
      keepFrames: (old, fresh) => ccb.draw.keepFrames(old, fresh),
      media: (url, label) => ccb.messages.media(url, label),
      mediaClicks: () => ccb.draw.mediaClicks(document),
    };
    const panel = new SpecPanel(root, panelIO);
    const show = (data: { state?: SpecState | null; chat?: string; lang?: string | null } | null) => {
      if (data?.lang) document.documentElement.lang = data.lang;
      if (data?.chat) chat = data.chat;
      if (data?.state) panel.update({ ...data.state, ...(data.lang ? { lang: data.lang } : {}) });
    };
    const off = ccb.on("spec", (data) => show(data as never));
    // The page opened after the spec did: asks for it.
    void call("state").then((data) => show(data as never), failed);
    return off;
  }));
  return () => { for (const dispose of disposers.splice(0)) dispose(); };
}
