// Extend only the desktop's interval footer policy. Keep Web/src's summary groups, citation
// viewer, folding and retry implementation, and the actual message roles, unchanged for 1.x.
import { IntervalSummaries } from "../../../../Web/src/catchup";
import { post } from "../../../../Web/src/bridge";
import { t } from "../../../../Web/src/i18n";
import { isSummaryReply } from "../../contract/summary";

const updates = IntervalSummaries.prototype.update;
const triggers = new WeakMap<IntervalSummaries, Map<string, HTMLButtonElement>>();
function removeTrigger(button: Element) {
  const footer = button.parentElement;
  button.remove();
  if (footer?.classList.contains("message-footer") && footer.childElementCount === 0) footer.remove();
}
const icon = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h9"/></svg>';

// The shared page calls this method for both new state and its own redraws (including toggling
// the source viewer). Adapting it here keeps notification footers in sync without changing 1.x.
IntervalSummaries.prototype.update = function (state, element) {
  updates.call(this, state, element);
  let buttons = triggers.get(this);
  if (!buttons) { buttons = new Map(); triggers.set(this, buttons); }
  const retained = new Set<string>();
  const covered = new Set((state.intervalSummaries ?? []).flatMap(view => view.ids));
  if (!state.subagent) for (let start = 0; start < state.messages.length; start++) {
    const user = state.messages[start];
    if (user.role !== "user") continue;
    let end = start + 1;
    while (end < state.messages.length && state.messages[end].role !== "user") end++;
    const source = state.messages.slice(start + 1, end);
    start = end - 1;
    // Leave pure assistant intervals to the shared implementation.
    if (!source.some(message => message.role === "notice")) continue;
    const replies = source.filter(isSummaryReply);
    const last = replies.at(-1);
    const key = `${state.botID}:${user.id}`;
    let button = buttons.get(key);
    // Replace the shared bot-only trigger, including in mixed bot/notice intervals. Keep our
    // retained button attached so a background state update does not drop keyboard focus.
    for (const message of source) element(message.id)?.querySelectorAll(".interval-summary-trigger").forEach(trigger => {
      if (trigger !== button) removeTrigger(trigger);
    });
    if (!last || covered.has(last.id)) continue;
    const row = element(last.id);
    if (!row) continue;
    let footer = row.querySelector<HTMLElement>(".message-footer");
    if (!footer) {
      let holder = row.querySelector<HTMLElement>(".speaker-column, .bot-column, .reaction-message-column");
      if (!holder) {
        const bubble = row.querySelector<HTMLElement>(".bot-bubble, .notice-bubble");
        if (!bubble) continue;
        holder = document.createElement("div");
        holder.className = "reaction-message-column";
        bubble.replaceWith(holder);
        holder.append(bubble);
      }
      footer = document.createElement("div");
      footer.className = "message-footer";
      holder.append(footer);
    }
    retained.add(key);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "interval-summary-trigger";
      button.addEventListener("click", () => post({ type: "catchUpManual", botID: state.botID, userMessageID: user.id }));
      buttons.set(key, button);
    }
    button.replaceChildren();
    button.insertAdjacentHTML("afterbegin", icon);
    button.append(document.createTextNode(t("interval.summarize", { n: replies.length })));
    if (button.parentElement !== footer) footer.append(button);
  }
  for (const [key, button] of buttons) if (!retained.has(key)) {
    removeTrigger(button);
    buttons.delete(key);
  }
};
