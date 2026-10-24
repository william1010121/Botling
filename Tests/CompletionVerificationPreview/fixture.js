// Synthetic replies, rendered by the production bundled chat surface.
window.verificationFixture = {
  botID: "verification-preview", botName: "botling", working: false, avatar: "", placeholder: "Message…",
  replyingTo: null, pendingFiles: [], components: {}, lang: "en",
  messages: ["Claude", "Codex"].map((head, index) => ({
    id: head.toLowerCase(), role: "bot", speaker: `botling · ${head}`, avatar: null, stamp: null,
    text: index ? "The screen check is complete; the authorized worker still needs to report its result." : "The implementation is ready. Completion still depends on the worker report.",
    choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false,
    completionVerification: { model: "gpt-6-luna", state: "judged", verdict: "WAITING_DEPENDENCY", reason: "Authorized work is assigned to worker 85b21f61-42c4-46bb-b67f-aef57829a245. The screen check has reported back; the memory update is not yet complete. 已授權工作仍待 worker 回報。" },
  })),
};
ccb.setState(verificationFixture);
window.verificationMeasure = () => ({
  overflow: document.querySelector("#scroller").scrollWidth > document.querySelector("#scroller").clientWidth,
  cards: [...document.querySelectorAll(".completion-verification")].map(card => ({
    open: card.open,
    height: card.getBoundingClientRect().height,
    summaryHeight: card.querySelector("summary").getBoundingClientRect().height,
    summary: card.querySelector("summary").textContent,
    model: card.querySelector(".verification-model").textContent,
    detailHeight: card.querySelector(".verification-details").getBoundingClientRect().height,
  })),
});
true;
