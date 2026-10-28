// Production components, synthetic historical metadata; no core or engines.
import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TokenFlow } from '../../../src/renderer/TokenFlow';
import '../../../src/renderer/styles.css';
import '../../../src/renderer/token-flow.css';
import type { BotView, UsageView, TokenFlowHistoryView } from '../../../src/contract';
import type { Client } from '../../../src/renderer/client';
const params = new URLSearchParams(location.search);
if (params.has('light')) document.documentElement.dataset.theme = 'light';
const empty = params.has('empty'), now = Date.now(), day = 86400000;
const row = (id: string, title: string, output: number | null, age: number, parentId: string | null = null) => ({ id, title, parentId, head: 'codex' as const, status: age > 1 ? 'completed' as const : 'running' as const, startedAt: now - age * day, endedAt: age > 1 ? now - age * day + 3600000 : null, outputTokens: output, attributableOutputTokens: output });
const bot: BotView = { id: 'main', name: 'Main', role: 'main', avatar: 'square', folder: '', phase: 'awake', working: true, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ['codex'], job: null, subagentRows: [], delegationRows: empty ? [] : [
  row('build', 'Build Token Flow', 12400, .002), row('review', 'Independent review', 3200, .001), row('check', 'Check narrow layouts', null, .001, 'review'),
] };
const tokens = { input: 84000, output: 22000, cacheRead: 132000, cacheWrite: 0 };
const usage: UsageView = { spendingStatus: empty ? 'missing' : 'available', day: new Date().toLocaleDateString('en-CA'), spent: 0, tokens, byBot: [{ name: 'Main', tokens: 238000, spent: 0, breakdown: tokens }], history: [], claude: { fiveHour: null, week: null }, codex: { fiveHour: null, week: null } };
function history(current: BotView): TokenFlowHistoryView {
  const group = (id: string, taskId: string, purpose: "communication" | "execution" | "mixed" | "unknown", amount: number, workerId: string | null) => ({id,taskId,purpose,workerId,head:"codex",tokens:{input:amount*.5,output:amount*.2,cacheRead:amount*.3,cacheWrite:0},turns:3});
  const all = empty ? [] : [group("chat-plan","token-flow","communication",18000,null),group("build","token-flow","execution",70000,"build"),group("review","token-flow","mixed",22000,"review"),group("audit","audit","execution",30000,"old-audit"),group("oldchat","release","unknown",14000,null)];

  return { botId: current.id, asOf: Date.now(), limited: true, unreadable: false,
    metered: {since:now-14*day,limited:false,unreadable:false,periods:{all,today:all.slice(0,3),"7d":all.slice(0,4)}},
    rows: empty ? [] : [...current.delegationRows!, row('old-audit', 'Audit exports', 8800, 3), row('old-release', 'Release checks', 42000, 10)],
    tasks: empty ? [] : [
      { id: 'token-flow', name: 'Token Flow', workers: current.delegationRows!.map(record => ({ id: record.id, head: record.head })) },
      { id: 'audit', name: 'Export audit', workers: [{ id: 'old-audit', head: 'codex' }] },
      { id: 'release', name: 'Release', workers: [{ id: 'old-release', head: 'codex' }] },
    ],
  };
}
function Fixture() {
  const [current, setCurrent] = useState(bot);
  const client = useMemo(() => ({ request: async (command: { type: string }) => { if (params.has('failed')) throw new Error('fixture'); return command.type === 'tokenFlow.view' ? history(current) : usage; }, onEvent: () => () => {} }) as unknown as Client, [current]);
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', maxWidth: 1100, margin: 'auto' }}>
    <div className="board-switch-bar"><div className="board-switch"><button>Chat</button><button>Board</button><button aria-pressed="true">Token Flow</button></div></div>
    <button aria-label="Simulate telemetry update" style={{ position: 'fixed', bottom: 8, right: 8, fontSize: 10, zIndex: 10 }} onClick={() => setCurrent(value => ({ ...value, delegationRows: value.delegationRows!.map(record => record.id === 'review' ? { ...record, outputTokens: record.outputTokens! + 100, attributableOutputTokens: record.attributableOutputTokens! + 100 } : record) }))}>+ event</button>
    <TokenFlow client={client} bot={current} bots={[current]} tasks={[]} />
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
