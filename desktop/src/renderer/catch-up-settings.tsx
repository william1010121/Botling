// botling.catchup's settings (hidden on the Plugins page), drawn on Settings → Chat & reports: whether unread replies
// fold when you come back, and how many unread replies it takes. Nothing shows while that plugin is off.
import type { PluginsView } from "../contract";
import type { Client } from "./client";
import { Group, Row, Toggle, why } from "./settings-controls";

/** The built-in plugin that folds unread replies; its settings are set in Settings, not on the Plugins page. */
export const CATCH_UP = "botling.catchup";

export function CatchUpSettings({ client, plugins, onProblem }: { client: Client; plugins: PluginsView | null; onProblem: (problem: string | null) => void }) {
  const plugin = plugins?.plugins.find((candidate) => candidate.name === CATCH_UP && candidate.enabled && !candidate.failure);
  if (!plugin) return <Group title="Catch-up" note="Turn on the Catch-up plugin (Plugins) to set it here."><Row label="Catch-up" hint="The plugin is off." /></Group>;
  const setting = (key: string) => plugin.settings.find((entry) => entry.key === `${CATCH_UP}.${key}`);
  const value = (key: string) => setting(key)?.value ?? setting(key)?.default ?? null;
  const set = (key: string, next: boolean | number | string | null) => {
    onProblem(null);
    void client.request({ type: "plugins.setting", name: CATCH_UP, key: `${CATCH_UP}.${key}`, value: next }).catch((failure) => onProblem(why(failure)));
  };
  const threshold = typeof value("unreadThreshold") === "number" ? Math.min(50, Math.max(1, Math.round(value("unreadThreshold") as number))) : 3;
  return (
    <Group title="Catch-up" note="When you come back to a chat with many unread replies, the few that matter stay in view (up to 3: a question waiting for you, errors, cards, the newest replies) and the rest fold behind a small header. Nothing is summarized.">
      <Toggle label="Fold unread replies when I come back" checked={value("unread") !== false} onChange={(next) => set("unread", next)} />
      <Row label="Fold when more than this many replies are unread">
        <input type="number" aria-label="Unread threshold" min={1} max={50} value={threshold} onChange={(event) => { const next = Number(event.target.value); if (next >= 1 && next <= 50) set("unreadThreshold", Math.round(next)); }} />
      </Row>
    </Group>
  );
}
