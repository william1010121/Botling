import { describe, expect, it } from 'vitest';
import { SHORTCUTS, FIXED_SHORTCUTS, bindingsFor, normalizeOverrides, setBinding, resetBinding, findConflict, toAccelerator,
  matchesEvent, comboFromEvent, formatCombo, actionForEvent, parseCombo, legacyKey, pluginBindings, commandBindings, commandForEvent } from '../../src/contract/shortcuts';
import { applySetting, settingsView } from '../../src/core/settings';
import { SettingsChange } from '../../src/contract';

const ev = (init: Partial<KeyboardEvent> & { key: string }) => ({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('shortcut registry', () => {
  it('lists every app shortcut with today\'s default keys', () => {
    const defaults = Object.fromEntries(SHORTCUTS.map(s => [s.id, s.default]));
    expect(defaults).toEqual({ search: 'Mod+K', settings: 'Mod+,', subBots: 'Mod+Shift+S', roomBack: 'Mod+[', roomForward: 'Mod+]',
      pinnedSubBot1: 'Mod+Alt+1', pinnedSubBot2: 'Mod+Alt+2', pinnedSubBot3: 'Mod+Alt+3', pinnedSubBot4: 'Mod+Alt+4', pinnedSubBot5: 'Mod+Alt+5',
      pinnedSubBot6: 'Mod+Alt+6', pinnedSubBot7: 'Mod+Alt+7', pinnedSubBot8: 'Mod+Alt+8', pinnedSubBot9: 'Mod+Alt+9', toggleSidebar: 'Ctrl+Cmd+S', toggleRightPanel: 'Ctrl+Cmd+I', toggleWorkers: 'Mod+Shift+W', toggleBrowser: 'Mod+Shift+B',
      reload: 'Mod+R', forceReload: 'Mod+Shift+R', reloadChat: 'Mod+Alt+R' });
    expect(new Set(SHORTCUTS.map(s => s.default)).size).toBe(SHORTCUTS.length);
    expect(FIXED_SHORTCUTS.length).toBeGreaterThan(5);
  });
  it('pinned sub bots default to Mod+Alt+1–9 (macOS keeps Cmd+Shift+3/4/5 for screenshots), clashing with no app, fixed or built-in plugin key', () => {
    const pinned = SHORTCUTS.filter(s => s.id.startsWith('pinnedSubBot'));
    expect(pinned.map(s => s.default)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `Mod+Alt+${n}`));
    const others = [...SHORTCUTS.filter(s => !pinned.includes(s)).map(s => s.default), ...FIXED_SHORTCUTS.map(s => s.combo), 'Mod+J', 'Mod+Shift+M'];
    for (const s of pinned) expect(others).not.toContain(s.default);
  });
  it('falls back to the default for unknown, malformed or missing bindings', () => {
    const overrides = normalizeOverrides({ search: 'Mod+L', bogus: 'Mod+X', settings: 'nonsense', reload: 42, toggleTerminal: 'Shift+J' });
    // (toggleTerminal is the Terminal plugin's command now; settings.ts moves a saved key once.)
    expect(overrides).toEqual({ search: 'Mod+L' });
    expect(bindingsFor(overrides).search).toBe('Mod+L');
    expect(bindingsFor(overrides).settings).toBe('Mod+,');
    expect(bindingsFor(null).reload).toBe('Mod+R');
    expect(normalizeOverrides('x')).toEqual({});
  });
  it('drops an override equal to the default and a later duplicate of an earlier binding', () => {
    expect(normalizeOverrides({ search: 'Mod+K' })).toEqual({});
    expect(normalizeOverrides({ search: 'Mod+L', settings: 'Mod+L' })).toEqual({ search: 'Mod+L' });
  });
  it('detects conflicts with other shortcuts and with fixed system keys, never with itself', () => {
    expect(findConflict('search', 'Mod+Shift+R', {})).toEqual({ kind: 'shortcut', id: 'forceReload' });
    expect(findConflict('search', 'Mod+K', {})).toBeNull();
    expect(findConflict('search', 'Mod+C', {})).toEqual({ kind: 'fixed', id: expect.any(String) });
    expect(findConflict('search', 'Mod+L', { settings: 'Mod+L' })).toEqual({ kind: 'shortcut', id: 'settings' });
    // the key a binding left is free for another
    expect(findConflict('search', 'Mod+R', { reload: 'Mod+T' })).toBeNull();
  });
  it('sets, resets one and resets all', () => {
    let o = setBinding({}, 'search', 'Mod+L');
    o = setBinding(o, 'reload', 'Mod+Shift+L');
    expect(o).toEqual({ search: 'Mod+L', reload: 'Mod+Shift+L' });
    expect(setBinding(o, 'search', 'Mod+K')).toEqual({ reload: 'Mod+Shift+L' });
    expect(resetBinding(o, 'reload')).toEqual({ search: 'Mod+L' });
    expect(bindingsFor(resetBinding(resetBinding(o, 'reload'), 'search'))).toEqual(bindingsFor({}));
  });
  it('turns a binding into an Electron accelerator and a readable label', () => {
    expect(toAccelerator('Mod+J')).toBe('CmdOrCtrl+J');
    expect(toAccelerator('Mod+Shift+R')).toBe('Shift+CmdOrCtrl+R');
    expect(toAccelerator('Mod+Alt+R')).toBe('Alt+CmdOrCtrl+R');
    expect(toAccelerator('Ctrl+Cmd+I')).toBe('Ctrl+Cmd+I');
    expect(toAccelerator('Mod+,')).toBe('CmdOrCtrl+,');
    expect(formatCombo('Mod+K', 'darwin')).toBe('⌘K');
    expect(formatCombo('Ctrl+Cmd+I', 'darwin')).toBe('⌃⌘I');
    expect(formatCombo('Mod+Shift+R', 'linux')).toBe('Ctrl+Shift+R');
  });
  it('matches key events, exactly on modifiers', () => {
    expect(matchesEvent('Mod+K', ev({ key: 'k', metaKey: true }))).toBe(true);
    expect(matchesEvent('Mod+K', ev({ key: 'K', ctrlKey: true }))).toBe(true);
    expect(matchesEvent('Mod+K', ev({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchesEvent('Ctrl+Cmd+I', ev({ key: 'i', metaKey: true, ctrlKey: true }))).toBe(true);
    expect(matchesEvent('Ctrl+Cmd+I', ev({ key: 'i', metaKey: true }))).toBe(false);
    expect(matchesEvent('Mod+,', ev({ key: ',', metaKey: true }))).toBe(true);
    expect(actionForEvent(ev({ key: 'j', metaKey: true }), bindingsFor({ search: 'Mod+T' }))).toBeNull();
    expect(actionForEvent(ev({ key: 't', metaKey: true }), bindingsFor({ search: 'Mod+T' }))).toBe('search');
  });
  it('records a combo from a key press and refuses bare keys', () => {
    expect(comboFromEvent(ev({ key: 'ø', code: 'KeyO', altKey: true, metaKey: true }), 'darwin')).toBe('Mod+Alt+O');
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'win32')).toBe('Mod+K');
    expect(comboFromEvent(ev({ key: 'i', code: 'KeyI', ctrlKey: true, metaKey: true }), 'darwin')).toBe('Ctrl+Cmd+I');
    expect(comboFromEvent(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), 'darwin')).toBe('Ctrl+K');
    expect(comboFromEvent(ev({ key: 'a', code: 'KeyA' }), 'darwin')).toBeNull();
    expect(comboFromEvent(ev({ key: 'Shift', shiftKey: true, metaKey: true }), 'darwin')).toBeNull();
    expect(comboFromEvent(ev({ key: 'F5', code: 'F5' }), 'darwin')).toBe('F5');
    expect(parseCombo('Mod+Mod+K')).toBeNull();
    expect(parseCombo('K')).toBeNull();
  });
});

describe('shortcut settings', () => {
  it('stores overrides under their own key, defaults to none and ignores bad stored values', () => {
    expect(settingsView({}).shortcuts).toEqual({});
    const saved = applySetting({}, { key: 'shortcuts', value: { search: 'Mod+L', bogus: 'Mod+Q' } });
    expect(saved.shortcutBindings).toEqual({ search: 'Mod+L' });
    expect(settingsView(saved).shortcuts).toEqual({ search: 'Mod+L' });
    expect(settingsView({ shortcutBindings: { search: 5, reload: 'Mod+Shift+L' } }).shortcuts).toEqual({ reload: 'Mod+Shift+L' });
    expect(applySetting(saved, { key: 'shortcuts', value: {} }).shortcutBindings).toBeUndefined();
    expect(SettingsChange.safeParse({ key: 'shortcuts', value: { search: 'Mod+L' } }).success).toBe(true);
  });
});

describe('plugin keybindings', () => {
  const latex = { command: 'ccb-latex.insert', key: 'cmd+shift+m', plugin: 'ccb-latex', title: 'Insert inline formula' };
  const uptime = { command: 'uptime.refresh', key: 'Mod+Shift+U', plugin: 'uptime', title: 'Refresh uptime' };
  it('reads the old "cmd+shift+l" spelling as Mod+Shift+L, and the new spelling as it is', () => {
    expect(legacyKey('cmd+shift+l')).toBe('Mod+Shift+L');
    expect(legacyKey('ctrl+alt+k')).toBe('Ctrl+Alt+K');
    expect(legacyKey('option+cmd+1')).toBe('Mod+Alt+1');
    expect(legacyKey('cmd+ctrl+i')).toBe('Ctrl+Cmd+I');
    expect(legacyKey('Mod+Shift+U')).toBe('Mod+Shift+U');
    expect(legacyKey('shift+l')).toBeNull();
    expect(legacyKey('cmd+nonsense')).toBeNull();
  });
  it('binds a plugin command to its manifest key until you change it', () => {
    expect(commandBindings([latex, uptime], {})).toEqual({ 'ccb-latex.insert': 'Mod+Shift+M', 'uptime.refresh': 'Mod+Shift+U' });
    expect(commandBindings([latex, uptime], { 'uptime.refresh': 'Mod+Alt+U' })).toEqual({ 'ccb-latex.insert': 'Mod+Shift+M', 'uptime.refresh': 'Mod+Alt+U' });
    expect(commandForEvent(ev({ key: 'u', metaKey: true, shiftKey: true }), commandBindings([uptime], {}))).toBe('uptime.refresh');
    expect(commandForEvent(ev({ key: 'u', metaKey: true }), commandBindings([uptime], {}))).toBeNull();
  });
  it('never lets a plugin take an app shortcut, a system key or an earlier plugin\'s key', () => {
    const taken = [
      { command: 'a.search', key: 'Mod+K', plugin: 'a', title: 'A' },
      { command: 'b.copy', key: 'cmd+c', plugin: 'b', title: 'B' },
      { command: 'c.one', key: 'Mod+Shift+U', plugin: 'c', title: 'C' },
      { ...uptime },
    ];
    const bound = pluginBindings(taken, {});
    expect(bound.map(b => [b.command, b.combo, b.conflict])).toEqual([
      ['a.search', null, { kind: 'shortcut', id: 'search' }],
      ['b.copy', null, { kind: 'fixed', id: 'copy' }],
      ['c.one', 'Mod+Shift+U', null],
      ['uptime.refresh', null, { kind: 'command', id: 'c.one' }],
    ]);
    // The app shortcut keeps working exactly as before.
    expect(actionForEvent(ev({ key: 'k', metaKey: true }), bindingsFor({}))).toBe('search');
    // Moving the app shortcut away frees its key for the plugin.
    expect(commandBindings(taken, { search: 'Mod+L' })['a.search']).toBe('Mod+K');
  });
  it('detects conflicts between app shortcuts and plugin keys both ways', () => {
    expect(findConflict('search', 'Mod+Shift+U', {}, [uptime])).toEqual({ kind: 'command', id: 'uptime.refresh' });
    expect(findConflict('uptime.refresh', 'Mod+R', {}, [uptime])).toEqual({ kind: 'shortcut', id: 'reload' });
    expect(findConflict('uptime.refresh', 'Mod+Shift+M', {}, [latex, uptime])).toEqual({ kind: 'command', id: 'ccb-latex.insert' });
    expect(findConflict('uptime.refresh', 'Mod+Shift+U', {}, [uptime])).toBeNull();
    expect(findConflict('uptime.refresh', 'Mod+V', {}, [uptime])).toEqual({ kind: 'fixed', id: 'paste' });
  });
  it('keeps plugin overrides in settings, drops unusable ones, and resets to the manifest key', () => {
    expect(normalizeOverrides({ 'uptime.refresh': 'Mod+Alt+U', 'bad id': 'Mod+Alt+B', 'x.y': 'Mod+C', 'x.z': 'Mod+R', search: 'Mod+L' }))
      .toEqual({ search: 'Mod+L', 'uptime.refresh': 'Mod+Alt+U' });
    let o = setBinding({}, 'uptime.refresh', 'Mod+Alt+U', uptime.key);
    expect(o).toEqual({ 'uptime.refresh': 'Mod+Alt+U' });
    expect(setBinding(o, 'uptime.refresh', 'Mod+Shift+U', uptime.key)).toEqual({});
    o = resetBinding(o, 'uptime.refresh');
    expect(commandBindings([uptime], o)['uptime.refresh']).toBe('Mod+Shift+U');
    const saved = applySetting({}, { key: 'shortcuts', value: { 'uptime.refresh': 'Mod+Alt+U' } });
    expect(settingsView(saved).shortcuts).toEqual({ 'uptime.refresh': 'Mod+Alt+U' });
    expect(SettingsChange.safeParse({ key: 'shortcuts', value: { 'a-plugin.with-a-long-command-name.that-runs': 'Mod+Alt+U' } }).success).toBe(true);
  });
});
