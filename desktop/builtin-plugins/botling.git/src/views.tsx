// The three views as components: what each reads from the program part and which of Botling's own commands it runs.
import { useEffect, useState } from "react";
import type { Client, Ccb } from "./client";
import { Worktrees } from "./WorktreesView";
import { worktreeWords } from "./worktree-text";

/** The app's language as the program part knows it (null until it answers). */
function useLanguage(ccb: Pick<Ccb, "call">): string | null {
  const [lang, setLang] = useState<string | null>(null);
  useEffect(() => { let live = true; void ccb.call("lang").then((value) => { if (live && typeof value === "string") setLang(value); }, () => {}); return () => { live = false; }; }, [ccb]);
  return lang;
}

/** The Worktrees block under a bot's tasks. (The Review tab is gone from the header; ReviewView and the host's review.* stay for a button to come back to.) */
export function WorktreesBlock({ ccb, client, botId }: { ccb: Ccb; client: Client; botId: string }) {
  const lang = useLanguage(ccb);
  if (!botId) return null;
  return <Worktrees client={client} bot={{ id: botId }} lang={lang} />;
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
