// A request the host writes names the code it was made by (`code`, the plugin's fingerprint; desktop plugins/requests.ts refuses
// older code). Most tests are about the rest of the params, so they record through this: the same message without `code`.
export const without = (message: any) => {
  if (!message || typeof message.method !== "string" || !message.params || typeof message.params !== "object" || !("code" in message.params)) return message;
  const { code: _code, ...rest } = message.params;
  return { ...message, params: rest };
};
export const sink = (written: any[]) => (message: any) => written.push(without(message));
