// Bounded UI fixture: production renderer and synthetic metadata only; no core or engines.
import { createRoot } from 'react-dom/client';
import { TokenFlow } from '../../../src/renderer/TokenFlow';
import '../../../src/renderer/styles.css';
import '../../../src/renderer/token-flow.css';
import type { BotView, UsageView, TaskView } from '../../../src/contract';
import type { Client } from '../../../src/renderer/client';
const params = new URLSearchParams(location.search);
if (params.has('light')) document.documentElement.dataset.theme = 'light';
const empty = params.has('empty');
const bot: BotView = { id: 'main', name: 'Main', role: 'main', avatar: 'square', folder: '', phase: 'awake', working: true, approvals: 0, unread: 0, subagents: 1, problem: null, heads: ['codex'], job: null, subagentRows: empty ? [] : [
  { id: 'build', title: 'Build Token Flow', status: 'completed', head: 'codex', startedAt: Date.now() - 120000, endedAt: Date.now(), settled: false, unsettledAt: null, prompt: '', outputTokens: 12400 },
  { id: 'review', title: 'Independent review', status: 'running', head: 'codex', startedAt: Date.now() - 60000, endedAt: null, settled: false, unsettledAt: null, prompt: '', outputTokens: 3200 },
  { id: 'check', title: 'Check narrow layouts', status: 'failed', head: 'codex', startedAt: Date.now() - 60000, endedAt: Date.now(), settled: false, unsettledAt: null, prompt: '', outputTokens: null },
] };
const tokens = { input: 84000, output: 22000, cacheRead: 132000, cacheWrite: 0 };
const usage: UsageView = { spendingStatus: empty ? 'missing' : 'available', day: '2026-10-28', spent: 0, tokens, byBot: [{ name: 'Main', tokens: 238000, spent: 0, breakdown: tokens }], history: [], claude: { fiveHour: null, week: null }, codex: { fiveHour: null, week: null } };
const client = { request: async () => { if (params.has('failed')) throw new Error('fixture'); return usage; }, onEvent: () => () => {} } as unknown as Client;
const tasks: TaskView[] = empty ? [] : [{ id: 'task-token-flow', name: 'Token Flow', state: 'running', owner: 'codex', now: null, next: null, blocked: null, messageIds: [], updatedAt: '', atWork: true, relatedAgents: bot.subagentRows.map(row => ({ id: row.id, title: row.title, engine: row.head, status: row.status, available: true, run: 1 })) }];
createRoot(document.getElementById('root')!).render(<div style={{ height: '100%', display: 'flex', flexDirection: 'column', maxWidth: 960, margin: 'auto' }}><div className="board-switch-bar"><div className="board-switch"><button>Chat</button><button>Board</button><button aria-pressed="true">Token Flow</button></div></div><TokenFlow client={client} bot={bot} bots={[bot]} tasks={tasks} /></div>);
