// Synthetic status data on the production chat surface; no installed app is controlled.
window.pinDockFixture = (count = 5, handoff = false) => ({
  botID: "pin-dock-preview", botName: "botling", working: false, avatar: "", lang: "en",
  placeholder: "Make a wish, or ask how things are going…", replyingTo: null, pendingFiles: [], messages: [],
  components: {},
  pins: Array.from({ length: count }, (_, index) => {
    const text = ["CPU 24%", "426/494 GB", "Memory 80%", "Today: Claude and Codex", "botling · use…"][index % 5];
    return { id: `P${index}`, name: `Status ${index}`, headline: text, chip: { text, tone: index ? "warning" : "good" },
      size: "2x2", refresh: "manual", minutes: 15, display: { name: `Status ${index}`, data: "{}" } };
  }),
  pinChoices: [{ name: "New status", uses: 1, pinned: false, command: null }],
  rounds: handoff ? { text: "Round 1 of 6", stop: "Stop now", kind: "handoff", round: 1, limit: 6 } : null,
});
window.pinDockMeasure = () => {
  const dock = document.querySelector(".pin-dock"), add = dock.querySelector(".add");
  const d = dock.getBoundingClientRect(), a = add.getBoundingClientRect();
  const chips = [...dock.querySelectorAll(".pin-chip:not(.add)")];
  const first = chips[0].getBoundingClientRect();
  return { height: d.height, addTop: a.top - d.top, addRight: a.right, dockRight: d.right,
    chipTop: first.top - d.top, count: chips.length, addWidth: a.width,
    oneRow: Math.abs(a.top - first.top) < 1 && Math.abs(d.height - 32) < 1,
    addVisible: a.left >= d.left && a.right <= d.right && a.width >= 30,
    overflow: document.documentElement.scrollWidth > innerWidth || d.right > innerWidth,
    scrollable: !!dock.querySelector(".pin-chip-list") && dock.querySelector(".pin-chip-list").scrollWidth > dock.querySelector(".pin-chip-list").clientWidth };
};
true;
