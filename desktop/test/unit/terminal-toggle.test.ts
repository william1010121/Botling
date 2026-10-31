import { describe, expect, it } from 'vitest';
import { terminalToggleAction } from '../../src/renderer/terminal-toggle';

describe('Cmd+J on the terminal panel', () => {
  const base = { botExists: true, visible: false, shells: undefined as number | undefined };
  it('does nothing without a bot or for a deleted bot', () => {
    expect(terminalToggleAction({ ...base, botExists: false })).toBe('none');
    expect(terminalToggleAction({ ...base, botExists: false, visible: true, shells: 0 })).toBe('none');
  });
  it('shows a never-opened panel (it opens its first shell as it mounts)', () => {
    expect(terminalToggleAction(base)).toBe('show');
  });
  it('opens a shell when the panel is empty, shown or hidden', () => {
    expect(terminalToggleAction({ ...base, visible: false, shells: 0 })).toBe('show-and-open');
    expect(terminalToggleAction({ ...base, visible: true, shells: 0 })).toBe('open');
  });
  it('toggles as before when shells exist', () => {
    expect(terminalToggleAction({ ...base, visible: false, shells: 2 })).toBe('show');
    expect(terminalToggleAction({ ...base, visible: true, shells: 1 })).toBe('hide');
  });
});
