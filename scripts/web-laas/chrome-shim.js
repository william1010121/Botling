// The part of `chrome.*` web-laas's isolated-world scripts use (content/isolated.ts and
// preview/entry.ts), for Botling's web views, where there is no extension. esbuild injects it
// (`inject`), so every free `chrome` in those scripts is this object; their source is not changed.
//
// It runs in the app's own content world (`WebLaas.world`): the page's scripts cannot see it.
//  - storage: the settings the app put in `window.__ccbLaasState` (a user script before this one);
//    what is missing, loadState() fills with web-laas's defaults. A change is sent to the app
//    (`set`), which keeps it and hands it to the app's other web views (`__ccbLaasSet`).
//  - runtime.sendMessage: the background's part. "load-preview" asks the app to run preview.js in
//    this frame; the two shortcuts are run here, as the background would.
//  - Both bundles (isolated and preview) in one frame share one state: it lives on the window.

const HANDLER = "ccbWebLaas";
const shared = (globalThis.__ccbLaasShim ??= {
  store: { ...(globalThis.__ccbLaasState ?? {}) },
  changed: [],
  messages: [],
});

function post(message) {
  try {
    globalThis.webkit.messageHandlers[HANDLER].postMessage(message);
    return true;
  } catch {
    return false;
  }
}

/** Takes `patch` into the store and tells both bundles what changed. */
function apply(patch) {
  const changes = {};
  for (const [key, value] of Object.entries(patch)) {
    changes[key] = { oldValue: shared.store[key], newValue: value };
    shared.store[key] = value;
  }
  if (Object.keys(changes).length) for (const fn of shared.changed) fn(changes, "local");
}

/** The app hands over a change made in another web view. */
globalThis.__ccbLaasSet = (patch) => apply(patch ?? {});

function toast(text, tone, hint) {
  for (const fn of shared.messages) fn({ type: "toast", text, tone, hint }, {}, () => {});
}

function runCommand(command) {
  if (command === "toggle-enabled") {
    const enabled = shared.store.enabled === false;
    chrome.storage.local.set({ enabled });
    toast(enabled ? "LaTeX auto-expand is on" : "LaTeX auto-expand is paused", enabled ? "on" : "off", "⌥⇧L to switch");
  } else if (command === "toggle-cheatsheet") {
    toast("The cheat sheet is not in Botling", "info", "Use the web-laas extension in a browser for it");
  }
}

export const chrome = {
  runtime: {
    id: "claudecodebot",
    sendMessage(message) {
      switch (message?.type) {
        case "load-preview":
          return post({ type: "load-preview" }) ? Promise.resolve(true) : Promise.reject(new Error("no app"));
        case "run-command":
          runCommand(message.command);
          return Promise.resolve();
        case "shortcuts":
          return Promise.resolve({});
        default:
          // (the composer is not bundled: there is nothing to load)
          return Promise.resolve(false);
      }
    },
    onMessage: { addListener: (fn) => shared.messages.push(fn) },
  },
  storage: {
    local: {
      get(keys) {
        const list = keys == null ? Object.keys(shared.store) : [].concat(keys);
        return Promise.resolve(Object.fromEntries(list.filter((k) => k in shared.store).map((k) => [k, shared.store[k]])));
      },
      set(patch) {
        apply(patch);
        post({ type: "set", patch });
        return Promise.resolve();
      },
    },
    onChanged: { addListener: (fn) => shared.changed.push(fn) },
  },
};
