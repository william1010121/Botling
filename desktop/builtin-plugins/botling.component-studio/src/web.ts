// botling.component-studio's web part, in the chat page: draws the chips its program part put under replies (message decorations). What they
// ask goes to the program part (desk.ts, through `ccb.call`); a command that is not allowed yet asks for your OK on the app's own sheet
// (`ccb.requestApproval`), then runs.
import type { CcbWeb } from "../../../../Web/src/plugins";
import { chipRenderer, type ChipIO } from "./chips";

/** What a press or a chip action answers (`ActResult`). */
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
    undo: (id) => act("undo", { id }),
    restore: (id) => act("restore", { id }),
    run: (chat, id, request) => { void allowed(chat, "command", { id, ...request }).catch(failed); },
  };
  const disposers: (() => void)[] = [ccb.decorations.register(chipRenderer(ccb.draw, io))];

  return () => { for (const dispose of disposers.splice(0)) dispose(); };
}
