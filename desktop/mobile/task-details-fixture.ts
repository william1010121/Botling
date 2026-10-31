// Isolated data/transport for responsive Details interaction tests. App and its handlers stay real.
import type { BotView, Command, ResultOf } from '../src/contract';
import type { Client } from '../src/renderer/client';
import { WorkspaceStore } from '../src/renderer/store';

export function detailsFixture(group = false) {
  const commands: Command[] = [];
  let collapsed = true;
  const primary: BotView = { id: 'project', name: 'Project', role: 'manager', avatar: 'circle', folder: '/fixture', phase: 'awake', working: false,
    approvals: 0, unread: 0, subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [] };
  const team: BotView = { ...primary, id: 'group', name: 'Review group', role: 'group', members: ['project'] };
  const snapshot = (botId = group ? team.id : primary.id): ResultOf<'chat.snapshot'> => ({ epoch: 'fixture', seq: 1, imported: null, components: {}, plugins: { plugins: [], broken: [], host: { running: false, problem: null }, secretsProblem: null }, teams: [], waiting: { items: [], doing: {} },
    settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, messageColumnWidth: null, rightPanelCollapsed: collapsed, railCollapsed: false, pinnedBots: [],
      catchUpEnabled: false, intervalSummaryEnabled: false, thresholdsCustomized: false, catchUpThreshold: 3, intervalSummaryThreshold: 3,
      catchUpModel: 'fixture', summaryPrompt: null, defaultSummaryPrompt: '',
      subagentModel: null, subagentHourCache: false, claudeBypassPermissions: false, codexBypassPermissions: false, codexWorkersFollow: true,
      codexWorkers: { model: null, effort: null, fast: null }, componentEditorModel: 'sonnet', resultPublishing: 'localOnly', stallReminderMinutes: 15,
      developerMode: false, developerProject: null, updateCheck: false },
    bots: [primary, team], chat: { botId, messages: [], running: null, live: [], tasks: [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [], pendingFiles: [] },
  });
  const store = new WorkspaceStore(async botId => snapshot(botId));
  const client = { request: async (cmd: Command) => {
    commands.push(cmd);
    if (cmd.type === 'bot.settings') return { botId: cmd.botId, engines: ['claude'], model: null, effort: null, subagentModel: null, codexModel: null };
    // Only this isolated preference can change, to expose unintended App handler writes.
    if (cmd.type === 'settings.set' && cmd.change.key === 'rightPanelCollapsed') {
      collapsed = cmd.change.value; await store.resync(); return store.getView().settings;
    }
    throw new Error(`Fixture rejects command: ${cmd.type}`);
  }, onEvent: () => () => {} } as unknown as Client;
  return { client, store, commands, savedCollapsed: () => collapsed };
}
