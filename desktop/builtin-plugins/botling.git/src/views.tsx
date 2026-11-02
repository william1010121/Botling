// The three views as components: what each reads from the program part and which of Botling's own commands it runs.
import { useEffect, useState } from "react";
import type { Client, Ccb } from "./client";
import { Review, type ReviewTarget } from "./ReviewView";
import { Worktrees } from "./WorktreesView";
import { worktreeWords } from "./worktree-text";

const REVIEW_TAB = ["botling.git", "botling.git.review"] as const;
/** How often an open Review tab asks whether the Worktrees block sent it somewhere else (ms). */
export const TARGET_POLL_MS = 1_000;

/** The app's language as the program part knows it (null until it answers). */
function useLanguage(ccb: Pick<Ccb, "call">): string | null {
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => { let live = true; void ccb.call("lang").then((value) => { if (live && typeof value === "string") setLang(value); }, () => {}); return () => { live = false; }; }, [ccb]);
  return lang;
}

/** The Worktrees block under a bot's tasks; "Review" opens the Review tab on that worktree (or on the main checkout). */
export function WorktreesBlock({ ccb, client, botId }: { ccb: Ccb; client: Client; botId: string }) {
  const lang = useLanguage(ccb);
  if (!botId) return null;
  const review = (target: ReviewTarget) => {
    void client.request({ type: "review.open", botId, target }).then(() => ccb.command("botling.openTab", botId, ...REVIEW_TAB), () => {});
  };
  return <Worktrees client={client} bot={{ id: botId }} lang={lang} onReview={review} />;
}

/** The Review tab of a bot's header: what the Worktrees block last asked for (the main checkout at first). */
export function ReviewTab({ ccb, client, botId }: { ccb: Ccb; client: Client; botId: string }) {
  const lang = useLanguage(ccb);
  const [shown, setShown] = useState<{ bot: { id: string; name: string }; target: ReviewTarget } | null>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, last = "";
    const tick = async () => {
      try {
        const answer = (await client.request({ type: "review.target", botId })) as { bot: { id: string; name: string }; target: ReviewTarget; stamp: number } | null;
        if (live && answer && String(answer.stamp) !== last) { last = String(answer.stamp); setShown({ bot: answer.bot, target: answer.target }); }
      } catch { /* asked again */ }
      if (live) timer = setTimeout(tick, TARGET_POLL_MS);
    };
    void tick();
    return () => { live = false; clearTimeout(timer); };
  }, [client, botId]);
  if (!shown) return null;
  return <Review client={client} bot={shown.bot} target={shown.target} lang={lang} onClose={() => ccb.command("botling.openChat", botId)} />;
}

/** Settings → Worktrees: the two settings the Developer page used to hold. */
export function SettingsBlock({ ccb }: { ccb: Ccb }) {
  const lang = useLanguage(ccb);
  const words = worktreeWords(lang).setting;
  const [state, setState] = useState<{ enabled: boolean; root: string } | null>(null);
  const [folder, setFolder] = useState("");
  useEffect(() => {
    void ccb.call("settings").then((value) => { const next = value as { enabled: boolean; root: string }; setState(next); setFolder(next.root); }, () => {});
  }, [ccb]);
  if (!state) return null;
  const save = (change: Partial<{ enabled: boolean; root: string }>) => {
    void ccb.call("settings.set", change).then((value) => setState(value as { enabled: boolean; root: string }), () => {});
  };
  return (
    <div className="settings-group">
      <h3>{words.title}</h3>
      <div className="settings-card">
        <div className="settings-row">
          <label>{words.toggle}<div className="settings-hint">{words.note}</div></label>
          <input type="checkbox" checked={state.enabled} aria-label={words.toggle} onChange={(event) => save({ enabled: (event.target as HTMLInputElement).checked })} />
        </div>
        <div className="settings-row">
          <label>{words.folder}<div className="settings-hint">{words.hint}</div></label>
          <input type="text" className="worktree-input" aria-label={words.folder} value={folder} disabled={!state.enabled} placeholder="/absolute/path"
            onChange={(event) => setFolder((event.target as HTMLInputElement).value)}
            onBlur={() => { if (folder.trim() !== state.root) save({ root: folder.trim() }); }} />
        </div>
      </div>
    </div>
  );
}
