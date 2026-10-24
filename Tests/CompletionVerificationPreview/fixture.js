// Synthetic replies, rendered by the production bundled chat surface.
window.verificationFixture = {
  botID: "verification-preview", botName: "botling", working: false, avatar: "", placeholder: "Message…",
  replyingTo: null, pendingFiles: [], components: {}, lang: "en",
  messages: ["Claude", "Codex"].map((head, index) => ({
    id: head.toLowerCase(), role: "bot", speaker: `botling · ${head}`, avatar: null, stamp: null,
    text: index ? "The screen check is complete; the authorized worker still needs to report its result." : "The presentation change is complete and the checks passed.",
    choices: null, chosen: null, answer: null, open: false, attachments: null, replyTo: null, replyPreview: null, openable: false,
    reactionEnabled: true, reactions: [],
    tasks: [{ id: 'done', kind: 'command', title: 'UI checks', status: 'completed', started: 0, ended: 1000, detail: null }],
    seen: [{ name: 'Claude', mark: 'C', seen: false }, { name: 'Codex', mark: 'X', seen: true }],
    completionVerification: { model: "gpt-6-luna", state: "judged", verdict: index ? "WAITING_DEPENDENCY" : "COMPLETE", reason: index ? "Authorized work is assigned to worker 85b21f61-42c4-46bb-b67f-aef57829a245. The screen check has reported back; the memory update is not yet complete. 已授權工作仍待 worker 回報。" : "All authorized presentation changes and checks passed." },
  })),
};
ccb.setState(verificationFixture);
window.verificationMeasure = () => {
  const rect = node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
  return {
    overflow: document.querySelector("#scroller").scrollWidth > document.querySelector("#scroller").clientWidth,
    cards: [...document.querySelectorAll(".completion-verification")].map(card => ({
      open: card.classList.contains("open"), inFooter: card.parentElement.classList.contains('message-footer'),
      summary: card.querySelector(".verification-toggle").textContent, label:card.querySelector(".verification-toggle").getAttribute('aria-label'),
      model: card.querySelector(".verification-model").textContent,
      summaryRect: rect(card.querySelector('.verification-toggle')), detailsRect: rect(card.querySelector('.verification-details')),
      actions: [...card.closest('.row').querySelectorAll('.task-summary,.reactions,.seen-marks')].map(rect),
    })),
  };
};
true;
