import { expect, it, vi } from 'vitest';
import { Core } from '../../src/core/server';
import { RestartJournal, type RestartEntry } from '../../src/core/restart-continuation';
import { tempDir } from '../helpers';

const entry = (botId: string): RestartEntry => ({ botId, engine: 'claude', sessionId: `${botId}-session`, continue: true, queued: [] });

/** A core restarting for an install: `busy` has work in flight; `failing` (no work) fails its own shutdown. */
function restarting(failing: 'other-bot' | 'busy-bot' | 'plugins') {
  const core = Object.create(Core.prototype) as any;
  core.options = { dataDir: tempDir('restart-shutdown') };
  const fail = () => Promise.reject(new Error('ACP cleanup incomplete.'));
  core.bots = new Map([
    ['busy', { restartEntries: () => [entry('busy')], holdForSwap: vi.fn(), shutdown: failing === 'busy-bot' ? fail : () => Promise.resolve() }],
    ['other', { restartEntries: () => [], holdForSwap: vi.fn(), shutdown: failing === 'other-bot' ? fail : () => Promise.resolve() }],
  ]);
  core.plugins = { shutdown: failing === 'plugins' ? fail : () => Promise.resolve() };
  core.prepareRestart();
  return core;
}

function recovered(core: any) {
  const deliver = vi.fn(), notice = vi.fn();
  new RestartJournal(core.options.dataDir).recover(deliver, notice);
  return { delivered: deliver.mock.calls.map(([e]) => e.botId), notices: notice.mock.calls.map(([e, reason]) => [e.botId, reason]) };
}

it.each(['other-bot', 'plugins'] as const)('a failed shutdown elsewhere (%s) does not pause the continuation of a bot that stopped cleanly', async (failing) => {
  const core = restarting(failing);
  await expect(core.shutdown()).rejects.toThrow('Core shutdown failed');
  expect(recovered(core)).toEqual({ delivered: ['busy'], notices: [] });
});

it("a bot whose own shutdown failed is held back with that failure, not resumed", async () => {
  const core = restarting('busy-bot');
  await expect(core.shutdown()).rejects.toThrow('Core shutdown failed');
  const { delivered, notices } = recovered(core);
  expect(delivered).toEqual([]);
  expect(notices).toHaveLength(1);
  expect(notices[0][0]).toBe('busy');
  expect(notices[0][1]).toContain('ACP cleanup incomplete.');
});
