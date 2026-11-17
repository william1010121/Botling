// The second layer of the plugin dependency board (botling.deps): which parts of the app a plugin uses. Not kernel services (those
// are `uses.services` in a manifest and stay as they are): these are the calls a plugin makes into the app itself, in two places.
//   · `api.<area>.<member>`: a request its program part (`main.js`) makes of the core (`api.usage.view`, `api.routines.list`, ...),
//     whose source is Web/host/src/api.ts;
//   · `ccb.<area>.<member>`: what its web part (`ui.js` / `dist/web.js`) uses of the chat page (`ccb.composer.insert`,
//     `ccb.messages.afterRender`, ...), whose source is Web/src/plugins.ts (`CcbWeb`).
// The list a built-in plugin has is DECLARED below (`BUILTIN_FEATURES`), so the board never guesses at run time; a test scans the built
// bundles of every built-in plugin with `scanFeatures` and fails when what a bundle calls is not what is declared here (a call added,
// removed or moved to another member). The scan reads property chains of a closed list of members (`HOST_SURFACE` / `WEB_SURFACE`), never
// free text, so `state.messages.find` or `spec.bots.map` are not mistaken for the app's. What is left out on purpose is a plugin's own
// plumbing, which is not "the app": storage, its own settings, `ui.expose` / `ui.emit`, commands it registers, events it listens to,
// `ccb.call`, `ccb.panels`, and the kernel service `composer.insertQuote` (the board shows that one as an arrow).
// Pure: no imports, so a test and the renderer-free core read it the same way.

export type FeatureSide = "host" | "web";

export interface FeatureArea {
  /** `api.bots` (a request of the core) or `ccb.composer` (a part of the chat page). */
  id: string;
  side: FeatureSide;
  /** What a person calls it in the app. */
  title: string;
  /** Every member of the app's surface in this area that counts as a feature (see the header for what does not). */
  members: readonly string[];
}

const area = (side: FeatureSide, name: string, title: string, members: string[]): FeatureArea => ({ id: `${side === "host" ? "api" : "ccb"}.${name}`, side, title, members });

/** The app's surface, by area, in the order the board lists them. */
export const FEATURE_AREAS: readonly FeatureArea[] = [
  area("host", "bots", "Bots", ["list", "folder", "send", "wake", "interrupt", "create", "onReply"]),
  area("host", "chat", "Chat messages", ["messages", "decorate", "setData"]),
  area("host", "sessions", "Sessions and folders", ["setFolder", "syncFolders", "bots"]),
  area("host", "notes", "Notes", ["read", "write", "importAsset", "assetUrls", "localizeImages", "parse", "outline", "mode", "components", "cards", "runCard"]),
  area("host", "routines", "Routines", ["add", "list", "change"]),
  area("host", "usage", "Usage", ["view"]),
  area("host", "plugins", "Plugins", ["deps"]),
  area("host", "app", "The app itself", ["state", "installAndRestart", "captureWindow", "card", "tell", "briefing"]),
  area("host", "studio", "Component studio", ["request"]),
  area("host", "workspace", "Workspace", ["bots", "memory", "tasks", "taskHistory", "results", "waiting", "ignoreWaiting", "pendingApprovals", "face", "current", "agyUsage", "agyWorkers", "agyWorkerUsage", "agyQuota", "component", "onChange"]),
  area("host", "approvals", "Command approvals", ["check", "state", "run"]),
  area("host", "cards", "Cards", ["library", "shown", "states", "run", "ask", "setNotes", "legacyPins"]),
  area("host", "settings", "App settings", ["app"]),
  area("host", "secrets", "Secrets", ["get", "set"]),
  area("host", "ui", "App screens", ["quickPick", "input", "openView", "takeover", "showTab"]),
  area("host", "workers", "Workers", ["start", "send", "cancel"]),
  area("host", "content", "Files and pictures", ["read", "fetch"]),
  area("host", "engines", "Engines", ["cli"]),
  area("host", "keybindings", "Keybindings", ["list", "set"]),
  area("host", "hooks", "Send and reply hooks", ["beforeSend", "afterReply"]),
  area("host", "replyTags", "Reply tags", ["on"]),
  area("web", "composer", "Chat input box", ["insert", "getText", "addExtension", "showPopover", "mentionSource", "chips", "view", "element", "onKeyDown", "onPaste"]),
  area("web", "messages", "Chat messages (drawing)", ["use", "userText", "afterRender", "cardBar", "render", "media", "taskChip"]),
  area("web", "decorations", "Chat decorations", ["register"]),
  area("web", "page", "Chat page", ["slots", "onState", "onWindowVisible", "post", "openChat", "requestApproval", "t", "language", "pieces", "isComposingEnter", "visible", "refresh", "components"]),
  area("web", "studio", "Component studio seam", ["specButton"]),
  area("web", "draw", "Component drawing", ["component", "pinButton", "keepFrames", "mediaClicks"]),
  area("web", "components", "Component renderers", ["register"]),
  area("web", "codemirror", "Input box editor", ["state", "view", "commands"]),
];

export const HOST_SURFACE: ReadonlyMap<string, readonly string[]> = new Map(FEATURE_AREAS.filter((entry) => entry.side === "host").map((entry) => [entry.id.slice(4), entry.members]));
export const WEB_SURFACE: ReadonlyMap<string, readonly string[]> = new Map(FEATURE_AREAS.filter((entry) => entry.side === "web").map((entry) => [entry.id.slice(4), entry.members]));

/** The feature id of `area` + `member` on `side` (`api.usage.view`, `ccb.composer.insert`). */
export const featureId = (side: FeatureSide, areaName: string, member: string) => `${side === "host" ? "api" : "ccb"}.${areaName}.${member}`;

/** The area an id belongs to (`api.usage.view` → `api.usage`); the id itself when it has fewer than three parts. */
export const areaOf = (id: string) => id.split(".").slice(0, 2).join(".");

/**
 * A bundler may bind a part of the app's surface to a short name (`s = draw; s.pinButton(...)`), which a property chain does not show.
 * These members are named so rarely that the call itself is the evidence. Each entry is a fact about a built bundle, kept short on purpose.
 */
const ALIASED: readonly { id: string; side: FeatureSide; call: RegExp }[] = [
  { id: "ccb.draw.pinButton", side: "web", call: /\.pinButton\(/ },
];

/** The features a bundle's text calls, sorted. `side` says which surface it is read against. Never throws. */
export function scanFeatures(text: string, side: FeatureSide): string[] {
  const surface = side === "host" ? HOST_SURFACE : WEB_SURFACE;
  const found = new Set<string>();
  // Every `.<area>.<member>` pair is looked at on its own (overlapping chains such as `a.b.c.d` give both `b.c` and `c.d`).
  for (const match of text.matchAll(/\.([A-Za-z]\w*)(?=\.([A-Za-z]\w*)(?![\w$]))/g)) {
    const members = surface.get(match[1]);
    if (members?.includes(match[2])) found.add(featureId(side, match[1], match[2]));
  }
  for (const alias of ALIASED) if (alias.side === side && alias.call.test(text)) found.add(alias.id);
  return [...found].sort();
}

/**
 * What each built-in plugin calls of the app, as the scan of its built bundles gives (host part with the `api` surface, web part with the
 * `ccb` surface). A plugin that calls nothing is listed with an empty list: the test fails for a built-in plugin that is not here.
 */
export const BUILTIN_FEATURES: Readonly<Record<string, readonly string[]>> = {
  "botling.board": [
    "api.bots.list",
    "api.cards.ask", "api.cards.legacyPins", "api.cards.library", "api.cards.run", "api.cards.setNotes", "api.cards.shown", "api.cards.states",
    "api.chat.setData",
    "ccb.messages.cardBar",
    "ccb.page.onState", "ccb.page.onWindowVisible", "ccb.page.slots",
    "ccb.studio.specButton",
  ],
  "botling.cards": [],
  "botling.catchup": [
    "api.chat.decorate", "api.chat.messages",
    "api.engines.cli",
    "api.settings.app",
    "ccb.decorations.register",
    "ccb.messages.media", "ccb.messages.render",
  ],
  "botling.chat-extras": [
    "ccb.composer.chips", "ccb.composer.insert", "ccb.composer.onPaste", "ccb.composer.view",
    "ccb.messages.afterRender", "ccb.messages.userText",
  ],
  "botling.component-studio": [
    "api.chat.decorate",
    "api.replyTags.on",
    "api.settings.app",
    "api.studio.request",
    "api.ui.takeover",
    "ccb.decorations.register",
    "ccb.draw.component", "ccb.draw.keepFrames", "ccb.draw.mediaClicks", "ccb.draw.pinButton",
    "ccb.messages.media",
  ],
  "botling.deps": [
    "api.plugins.deps",
  ],
  "botling.design": [],
  "botling.dev": [
    "api.app.briefing", "api.app.captureWindow", "api.app.card", "api.app.installAndRestart", "api.app.state", "api.app.tell",
    "api.bots.list",
    "api.replyTags.on",
  ],
  "botling.git": [
    "api.bots.send",
    "api.sessions.bots", "api.sessions.setFolder", "api.sessions.syncFolders",
    "api.settings.app",
  ],
  "botling.note": [
    "api.bots.send", "api.notes.outline", "api.notes.read", "api.notes.write",
  ],
  "botling.orchestration": [],
  "botling.pin-area": [
    "api.chat.decorate", "api.chat.setData", "api.hooks.beforeSend", "api.replyTags.on", "api.workspace.bots", "api.workspace.waiting",
    "ccb.composer.mentionSource", "ccb.decorations.register", "ccb.messages.afterRender", "ccb.messages.userText",
    "ccb.page.language", "ccb.page.onState", "ccb.page.openChat", "ccb.page.post", "ccb.page.slots",
  ],
  "botling.report": [],
  "botling.routines": [
    "api.routines.change", "api.routines.list",
  ],
  "botling.terminal": [
    "api.bots.folder",
  ],
  "botling.usage": [
    "api.usage.view",
  ],
  "botling.whiteboard": [
    "api.approvals.run",
    "api.bots.send",
    "api.replyTags.on",
    "api.settings.app",
    "api.workspace.component", "api.workspace.ignoreWaiting", "api.workspace.onChange",
  ],
  "ccb-latex": [
    "ccb.codemirror.view",
    "ccb.composer.addExtension", "ccb.composer.showPopover", "ccb.composer.view",
    "ccb.messages.afterRender", "ccb.messages.use",
  ],
};

/** What the built-in plugin `name` is declared to use (empty for one that is not built in or not listed). Own-property lookup: a name from outside is data. */
export function declaredFeatures(name: string): string[] {
  return Object.hasOwn(BUILTIN_FEATURES, name) ? [...BUILTIN_FEATURES[name]!] : [];
}
