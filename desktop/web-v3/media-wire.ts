// What the chat frame and the page's shell say to each other about a chat line's media (M2 step 9). The frame (a
// sandboxed, opaque-origin page) cannot talk to the server: it names a line's file, the shell asks the server over the
// session (`content.locate`) and answers with the `/v3/c/…` URL (with its ticket) or the reference's state.

/** One file of one line: the chat (bot), the line's id and the file URL the bot wrote. */
export interface MediaWant { key: string; botId: string; line: string; url: string }

/** What the shell knows of a wanted file. `none`: the line names no indexed file (or may not be read). */
export type MediaState = "ready" | "preparing" | "changed" | "gone" | "none";
export interface MediaAnswer { key: string; state: MediaState; src?: string }

export type FrameMediaMessage =
  | { botling3: "media.want"; items: MediaWant[] }
  /** An element showing `key` failed to load: the shell asks the server again. */
  | { botling3: "media.failed"; key: string };

export type ShellMediaMessage = { botling3: "media"; items: MediaAnswer[] };

export const mediaKey = (botId: string, line: string, url: string): string => `${botId}\n${line}\n${url}`;

/** Whether the bot's URL names a local file (what the server indexes): a file:// URL or an absolute path. */
export const isLocalMedia = (url: string): boolean => /^file:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//"));

/** The words a line shows instead of a file that changed after it (protocol v1 §9A.3). */
export const CHANGED_TEXT = "This file changed after this message.";
export const GONE_TEXT = "This file is no longer kept.";
