// "Make into component": before Maintainer builds the component, a fork of the bot that wrote the
// reply (`claude -p --resume <session> --fork-session`, with the bot's model, read-only, its
// transcript not kept) writes Maintainer a brief from what it knows of that conversation: what the
// component is for, the user's own message, each data field, and whether a CLI command can get it
// (the exact command) or only a bot can (explanations, advice). The fork is not the bot: nothing shows
// in its chat, it is not woken and its own session goes on untouched (1.x's ComponentBrief.swift;
// the strings are checked against the Swift app's, test/fixtures/phase5c-golden.json).
import { randomUUID } from "node:crypto";
import { ClaudeHead, type HeadConfig } from "./agent/head";
import { clip, FIELD_GROUP } from "./specs";

/** How long Maintainer's request waits for the brief (`ComponentBrief.timeout`, 120 s). */
export const BRIEF_TIMEOUT_MS = 120_000;
/** It only reads: its answer comes from the conversation it is a copy of. */
export const BRIEF_TOOLS = ["Read", "Grep", "Glob"];
export const BRIEF_DENIED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch", "AskUserQuestion"];
/** How much of the brief Maintainer gets. */
export const BRIEF_LIMIT = 8_000;
/** On --resume the session keeps its own system prompt; this only says what this copy is for. */
export const BRIEF_SYSTEM_PROMPT = "This is a read-only copy of your session, asked by the Botling app for a component brief. Change nothing.";

/** What the fork is asked: a brief in `<component-brief>`, from what it already knows (`ComponentBrief.request`). */
export function briefRequest(reply: { when: string; preview: string }, asked: string | null, folder: string): string {
  let text = `(App: The user pressed "Make into component" on your reply from ${reply.when} ("${reply.preview}"). Maintainer, who builds the app's chat components, will make it into a component that shows that reply's kind of content. Write Maintainer a brief. Do not do the work again: change nothing and run nothing; answer from what you already know in this conversation (you may Read a file to check a name or path).`;
  if (asked) text += "\nThe user's message that led to it, as the app has it:\n" + clip(asked, 4_000);
  text += `
Answer with only <component-brief>…</component-brief>, in English (keep the user's own words as they are), holding:
1. Purpose: what the component is for, in one or two sentences.
2. The user's message: the user's own message that led to that reply, verbatim.
3. Fields: each data field it should show (name, type, an example value), each marked as one of:
   - ${FIELD_GROUP.fromCommand}: a CLI command gets it. Give the exact command(s) you ran for it (or would run), run in ${folder}, and how the output maps to the field.
   - ${FIELD_GROUP.botOnly}: only a bot can write it (explanations, advice, a "next step"); shown only when a bot fills it.
4. Board command: when some fields are From command, one command (or a short script outline) that prints JSON with just those fields; else "none".
No words outside the tag.)`;
  return text;
}

/** The brief in an answer: what its `<component-brief>` holds, else the whole answer; null when that is empty (`brief(from:)`). */
export function briefFrom(answer: string): string | null {
  let text = answer;
  const open = answer.indexOf("<component-brief>");
  if (open >= 0) {
    const rest = answer.slice(open + "<component-brief>".length);
    const close = rest.indexOf("</component-brief>");
    text = close >= 0 ? rest.slice(0, close) : rest;
  }
  // Swift's .whitespacesAndNewlines.
  const trimmed = text.replace(/^[\s\u0085\u2028\u2029]+|[\s\u0085\u2028\u2029]+$/gu, "");
  return trimmed ? clip(trimmed, BRIEF_LIMIT) : null;
}

/** The fork's head: the bot's session resumed as a copy (`ComponentBrief.launch`). */
export function briefConfig(base: HeadConfig): HeadConfig {
  return {
    ...base,
    resume: true, forkSession: true, persistSession: false,
    systemPrompt: BRIEF_SYSTEM_PROMPT, allowedTools: BRIEF_TOOLS, askPermission: false, disallowedTools: BRIEF_DENIED_TOOLS,
    // A copy of the session needs none of the bot's plugins or extra folders to answer from memory.
    pluginDirs: base.pluginDirs ?? [],
  };
}

/**
 * Starts the fork, sends the prompt, and returns its brief: null when it could not start, failed, or
 * gave none within `timeoutMs`. The fork is ended either way (`ComponentBrief.writer`).
 */
export function writeBrief(config: HeadConfig, prompt: string, timeoutMs = BRIEF_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let text = "";
    const head: ClaudeHead = new ClaudeHead(config, {
      onItem: (item) => {
        if (item.kind === "delta") text += item.text;
        else if (item.kind === "assistantText" && !text) text = item.text;
        else if (item.kind === "result") settle(item.ok ? (item.text || text) : null);
        else if (item.kind === "permission") settle(null);
      },
      onExit: () => settle(null),
    });
    const timer = setTimeout(() => settle(null), timeoutMs);
    function settle(answer: string | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void head.terminate(1_000).catch(() => {});
      resolve(answer === null ? null : briefFrom(answer));
    }
    try {
      head.start();
      head.send(prompt, randomUUID());
    } catch {
      settle(null);
    }
  });
}
