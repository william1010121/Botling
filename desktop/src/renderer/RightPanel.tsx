// The right panel (1.x's DetailPanel): the bot on screen, its Now card (status; a manager's first
// "In progress" line from its memory.md) and, for the main bot, "Waiting on you" — every bot's open
// question or its memory's "Waiting on you", each opening that bot's chat, with × to ignore it
// (1.x's WaitingList). 2.0 leaves out what it does not have yet: teams, results, settled subagents.
import type { BotView, WaitingItemView, WaitingView } from "../contract";
import { faceURL } from "./avatars";

export function RightPanel({ bot, bots, waiting, look, onSelect, onIgnore, status }: {
  bot: BotView;
  bots: BotView[];
  waiting: WaitingView;
  look: "original" | "cute";
  onSelect: (botId: string) => void;
  onIgnore: (item: WaitingItemView) => void;
  status: { key: string; text: string };
}) {
  const doing = bot.role === "manager" ? waiting.doing[bot.id] : undefined;
  const items = bot.role === "main" ? waiting.items : [];
  return (
    <aside className="detail-panel" aria-label="Details">
      <div className="detail-head">
        <img className="detail-avatar" src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
        <span className="detail-name">{bot.name}</span>
      </div>
      <section className="detail-section">
        <h3>Now</h3>
        <div className="now-card">
          <div className="now-line"><span className="now-dot" data-status={status.key} aria-hidden="true" />{status.text}</div>
          {doing && <div className="now-doing">{doing}</div>}
        </div>
      </section>
      {items.length > 0 && (
        <section className="detail-section">
          <h3>Waiting on you</h3>
          <ul className="waiting-list">
            {items.map((item) => {
              const owner = bots.find((candidate) => candidate.id === item.botId);
              return (
                <li key={`${item.botId}-${item.text}`} className="waiting-item" data-bot={item.botId}>
                  <button type="button" className="waiting-open" onClick={() => onSelect(item.botId)} title={owner ? `Open ${owner.name}'s chat` : undefined}>
                    {owner && <img className="waiting-avatar" src={faceURL(owner, look, {})} alt="" />}
                    <span className="waiting-text">{item.text}</span>
                    <span className="waiting-chevron" aria-hidden="true">›</span>
                  </button>
                  <button type="button" className="waiting-ignore" aria-label="Ignore" title="Ignore: take it off this list without answering" onClick={() => onIgnore(item)}>×</button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </aside>
  );
}
