import type { Action } from "./types";

interface WebKitWindow {
  webkit?: { messageHandlers?: { ccb?: { postMessage(message: unknown): void } } };
}

/** Sends an action to the Swift side. Outside the app (tests, a browser) it is recorded instead. */
export function post(action: Action): void {
  const handler = (window as unknown as WebKitWindow).webkit?.messageHandlers?.ccb;
  if (handler) {
    handler.postMessage(action);
  } else {
    sent.push(action);
  }
}

/** Actions posted without a Swift side, for tests. */
export const sent: Action[] = [];
