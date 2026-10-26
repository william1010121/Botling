// The existing Claude editor, bound by Core to its own plugin-library Maintainer.
// Mirrors ComponentEditorRouting.swift: definition/model/tools stay authoritative;
// no generic worker fallback and no additional folders, plugins or approval grants.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionStart } from "../bot";
import { MAINTAINER_ID } from "../store/records";
import { Layout, type BotProfile } from "../store/workspace";
import type { HeadConfig } from "./head";

export type ComponentEditorRoute = { launch: HeadConfig; error?: never } | { error: string; launch?: never };
export type ComponentEditorAction =
  | { kind: "start"; task: string; run: number; config: HeadConfig; text: string }
  | { kind: "send"; task: string; run: number; text: string }
  | { kind: "stop"; task: string }
  | { kind: "answer"; task: string; run: number; requestId: string; allow: boolean; input: Record<string, unknown>; message?: string };

/** Only the exact profile Core created can acquire the route. Names, folders and copied IDs cannot. */
export function maintainerEditorBinding(owner: BotProfile, root: string, headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig) {
  const library = resolve(root, "plugins");
  return (profile: BotProfile, session: SessionStart): ComponentEditorRoute | null => {
    if (profile !== owner || profile.id !== MAINTAINER_ID || profile.role !== "manager"
      || resolve(profile.folder) !== library || resolve(profile.storeDir) !== resolve(Layout.bot(root, MAINTAINER_ID))) return null;
    const parent = headConfig(profile, session);
    if (resolve(parent.cwd) !== library) return { error: "The Maintainer editor's working folder does not match the app's plugin library. No editor was launched." };
    const file = join(library, "ccb-core", "claude", "agents", "component-editor.md");
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch { return { error: `Cannot load the existing component-editor definition at ${file}. No generic worker was substituted.` }; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    const fields: Record<string, string> = {};
    for (const line of match?.[1].split(/\r?\n/) ?? []) {
      const at = line.indexOf(":");
      if (at >= 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const role = match?.[2].trim();
    if (fields.name !== "component-editor" || !role) return { error: `Invalid component-editor definition at ${file}. No generic worker was substituted.` };
    if (!["haiku", "sonnet", "opus"].includes(fields.model)) return { error: "The component-editor definition has no supported explicit Claude model. No model or settings were substituted." };
    const tools = (fields.tools ?? "").split(",").map(tool => tool.trim()).filter(Boolean);
    if (!tools.length || tools.some(tool => !["Read", "Write", "Edit", "Bash"].includes(tool))) return { error: "The component-editor definition requests tools outside its existing Read/Write/Edit/Bash boundary; no tools or settings were changed." };
    return { launch: {
      command: parent.command, prefixArgs: parent.prefixArgs, cwd: library, env: parent.env,
      sessionId: session.sessionId, resume: false, model: fields.model, systemPrompt: role,
      allowedTools: tools, tools, disallowedTools: [...new Set([...(parent.disallowedTools ?? []), "Agent", "Task", "SendMessage"])],
      addDirs: parent.addDirs, effort: parent.effort, autoMode: parent.autoMode, allowRules: parent.allowRules,
      askPermission: parent.askPermission, harmless: parent.harmless, harmlessTools: parent.harmlessTools?.filter(tool => tools.includes(tool)),
    } };
  };
}
