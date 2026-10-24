// Runs before the Web/src chat page: the page talks to "the app" through WebKit's
// `webkit.messageHandlers.ccb.postMessage` (Web/src/bridge.ts). Here that goes to the app page
// (the React shell) instead, which owns the contract client.
const origin = location.origin;
(window as unknown as { webkit: unknown }).webkit = Object.freeze({
  messageHandlers: Object.freeze({
    ccb: Object.freeze({
      postMessage(action: unknown) {
        window.parent.postMessage({ botling: "action", action }, origin);
      },
    }),
  }),
});
export {};
