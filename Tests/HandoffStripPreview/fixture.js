// Synthetic data; uses the shipped chat.html/chat.js/chat.css unchanged.
window.handoffStripFixture = (count, mode, working = false) => ({
  ...pinDockFixture(count), working,
  messages: verificationFixture.messages,
  pins: pinDockFixture(count).pins.map(pin => ({ ...pin, chip: { text: 'Very long status label · CPU Memory Claude Codex 426/494 GB', tone: 'good' } })),
  rounds: mode === 'rounds' ? { text: 'Round 1 of 6', stop: 'Stop now', kind: 'handoff', round: 1, limit: 6 } : null,
  handoffs: ['task', 'waiting', 'many'].includes(mode) ? Array.from({ length: mode === 'many' ? 2 : 1 }, (_, i) => ({
    id: `H${i}`, from: 'claude', to: 'codex', kind: 'task', task: 'Check the status strip presentation', origin: 'Presentation only',
    state: mode === 'waiting' ? 'waiting' : 'running', round: 1, limit: 6, entries: [],
  })) : [],
});
window.handoffStripMeasure = () => {
  const rect = el => el?.getBoundingClientRect();
  const row = document.querySelector('.dock-row'), dock = row.querySelector('.pin-dock'), list = row.querySelector('.pin-chip-list');
  const chip = row.querySelector('.handoff-chip'), add = row.querySelector('.pin-chip.add');
  const r = rect(row), d = rect(dock), c = rect(chip), a = rect(add);
  const shown = el => !!el && !el.hidden && rect(el).width > 0;
  const inside = el => !shown(el) || (rect(el).left >= r.left - 1 && rect(el).right <= r.right + 1 && rect(el).top >= r.top - 1 && rect(el).bottom <= r.bottom + 1);
  const stop = chip.querySelector('.handoff-stop'), label = chip.querySelector('.handoff-label');
  return {
    rowHeight: r.height, rowWidth: r.width, dockHeight: d.height, chipHeight: c.height,
    oneRow: !shown(dock) || !shown(chip) || Math.abs(d.top - c.top) < 1,
    controlsVisible: [dock, chip, add, stop].every(inside),
    progressVisible: !shown(chip) || (rect(label).width > 35 && label.scrollWidth <= label.clientWidth + 1),
    stopVisible: !stop || (inside(stop) && rect(stop).width > 30),
    overflow: document.documentElement.scrollWidth > innerWidth || r.right > innerWidth || document.querySelector('#scroller').scrollWidth > document.querySelector('#scroller').clientWidth,
    scrollable: list.scrollWidth > list.clientWidth,
    label: label?.textContent ?? '', stop: stop?.textContent ?? '',
  };
};
true;
