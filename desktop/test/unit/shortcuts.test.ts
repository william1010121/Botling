import { describe, expect, it } from 'vitest';
import { SHORTCUTS, FIXED_SHORTCUTS, bindingsFor, normalizeOverrides, setBinding, resetBinding, findConflict, toAccelerator,
  matchesEvent, comboFromEvent, formatCombo, actionForEvent, parseCombo } from '../../src/contract/shortcuts';
import { applySetting, settingsView } from '../../src/core/settings';
import { SettingsChange } from '../../src/contract';

const ev = (init: Partial<KeyboardEvent> & { key: string }) => ({ code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe('shortcut registry', () => {
  it('lists every app shortcut with today\'s default keys', () => {
    const defaults = Object.fromEntries(SHORTCUTS.map(s => [s.id, s.default]));
    expect(defaults).toEqual({ search: 'Mod+K', settings: 'Mod+,', toggleSidebar: 'Ctrl+Cmd+S', toggleRightPanel: 'Ctrl+Cmd+I',
      toggleTerminal: 'Mod+J', reload: 'Mod+R', forceReload: 'Mod+Shift+R', reloadChat: 'Mod+Alt+R' });
    expect(new Set(SHORTCUTS.map(s => s.default)).size).toBe(SHORTCUTS.length);
    expect(FIXED_SHORTCUTS.length).toBeGreaterThan(5);
  });
  it('falls back to the default for unknown, malformed or missing bindings', () => {
    const overrides = normalizeOverrides({ search: 'Mod+L', bogus: 'Mod+X', settings: 'nonsense', reload: 42, toggleTerminal: 'Shift+J' });
    expect(overrides).toEqual({ search: 'Mod+L' });
    expect(bindingsFor(overrides).search).toBe('Mod+L');
    expect(bindingsFor(overrides).settings).toBe('Mod+,');
    expect(bindingsFor(null).toggleTerminal).toBe('Mod+J');
    expect(normalizeOverrides('x')).toEqual({});
  });
  it('drops an override equal to the default and a later duplicate of an earlier binding', () => {
    expect(normalizeOverrides({ search: 'Mod+K' })).toEqual({});
    expect(normalizeOverrides({ search: 'Mod+L', settings: 'Mod+L' })).toEqual({ search: 'Mod+L' });
  });
  it('detects conflicts with other shortcuts and with fixed system keys, never with itself', () => {
    expect(findConflict('search', 'Mod+J', {})).toEqual({ kind: 'shortcut', id: 'toggleTerminal' });
    expect(findConflict('search', 'Mod+K', {})).toBeNull();
    expect(findConflict('search', 'Mod+C', {})).toEqual({ kind: 'fixed', id: expect.any(String) });
    expect(findConflict('search', 'Mod+L', { settings: 'Mod+L' })).toEqual({ kind: 'shortcut', id: 'settings' });
    // the key a binding left is free for another
    expect(findConflict('search', 'Mod+J', { toggleTerminal: 'Mod+T' })).toBeNull();
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
    expect(actionForEvent(ev({ key: 'j', metaKey: true }), bindingsFor({ toggleTerminal: 'Mod+T' }))).toBeNull();
    expect(actionForEvent(ev({ key: 't', metaKey: true }), bindingsFor({ toggleTerminal: 'Mod+T' }))).toBe('toggleTerminal');
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
