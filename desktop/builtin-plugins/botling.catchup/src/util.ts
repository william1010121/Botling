// What catch-up needs of Botling's own helpers, kept here so the plugin depends on its API only.
// It must stay byte-for-byte what the core does; test/util.test.ts checks it against the core's.

/** Top-level reply content: app notifications count too, without being assistant heads (contract/summary.ts). */
export const isSummaryReply = (message: { role: string }): boolean => message.role === "bot" || message.role === "notice";
