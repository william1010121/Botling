/** Top-level summary content: app notifications are sources too, without being assistant heads. */
export const isSummaryReply = (message: { role: string }): boolean => message.role === "bot" || message.role === "notice";
