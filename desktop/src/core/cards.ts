// Cards: agent-written HTML shown in a sandboxed frame. A reply makes one with a fenced block
//   ```ccb-card
//   <button onclick="ccb.save({n: 1})">…</button>
//   ```
// The HTML is data to the app: it is stored, served only to a card frame, and never run in the
// app's own page.
import { randomUUID } from "node:crypto";
import type { CardView, MessageView } from "../contract";

const fence = /```ccb-card[^\n]*\n([\s\S]*?)```/g;

export function extractCards(text: string): { text: string; cards: CardView[] } | null {
  const cards: CardView[] = [];
  const rest = text.replace(fence, (_, html: string) => {
    if (cards.length < 20) cards.push({ id: `c-${randomUUID().slice(0, 8)}`, html: html.slice(0, 200_000), data: null });
    return "";
  });
  return cards.length ? { text: rest.trim(), cards } : null;
}

const counter = `<div class="counter">
  <p>This card runs in a sandboxed frame. Its only way out is <code>ccb.save</code> and <code>ccb.action</code>, checked by the app.</p>
  <button id="add">Count: <span id="n">0</span></button>
  <button id="say">Say hello</button>
</div>
<script>
  const n = document.getElementById('n');
  ccb.onData((data) => { n.textContent = String(data && data.count || 0); });
  document.getElementById('add').onclick = () => ccb.save({ count: Number(n.textContent) + 1 });
  document.getElementById('say').onclick = () => ccb.action('say', 'hello from the card');
</script>`;

export function welcomeMessages(): MessageView[] {
  const time = new Date().toISOString();
  return [
    {
      id: "m-welcome", role: "notice", time,
      text: "Botling 2.0 (preview). Messages go to the agent through the core process; Stop ends its whole process tree.",
      cards: [{ id: "c-counter", html: counter, data: null }],
    },
  ];
}
