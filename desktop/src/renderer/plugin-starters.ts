// ADR-006 M5: the Plugins page's "Ask Maintainer to build" entry. It only writes a request for the
// existing Maintainer flow (a chat message to Maintainer); nothing is built or installed from here.

export interface PluginStarter { id: string; title: string; text: string }

export const PLUGIN_STARTERS: PluginStarter[] = [
  { id: "panel", title: "A side panel", text: "Build a plugin with a panel in the right column that shows: " },
  { id: "command", title: "A command or shortcut", text: "Build a plugin with a command (and a keyboard shortcut) that: " },
  { id: "setting", title: "A plugin with settings", text: "Build a plugin with settings I can change on the Plugins page, that: " },
  { id: "card", title: "A card in chat", text: "Build a component card for chat that: " },
];

/** The message sent to Maintainer, or null when the description is empty. */
export function buildRequest(description: string): string | null {
  const text = description.trim();
  if (!text || PLUGIN_STARTERS.some((starter) => starter.text.trim() === text)) return null;
  return text.startsWith("Build ") ? text : `Build a plugin: ${text}`;
}
