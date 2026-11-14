// What the chat frame and the page's shell say to each other about a chat line's media (M2 steps 9 and 11). The frame (a
// sandboxed, opaque-origin page) cannot talk to the server: it names a line's file, the shell asks the server over the
// session (`content.locate`) and answers with the `/v3/c/…` URL (with its ticket) or the reference's state, plus what
// the player needs (step 11): the cached poster, the duration and size, the variant the 1.5× rule picked and the
// other one to switch to, the badge and the path's words.
import type { Choice, VariantName } from "./player";

/** One file of one line: the chat (bot), the line's id and the file URL the bot wrote. */
export interface MediaWant { key: string; botId: string; line: string; url: string }

/**
 * What the shell knows of a wanted file. `none`: the line names no indexed file (or may not be read). `failed`: it
 * could not be loaded after one more try (the frame shows a note instead of a broken element).
 */
export type MediaState = "ready" | "preparing" | "changed" | "gone" | "none" | "failed";
export type MediaKind = "video" | "audio" | "image" | "pdf" | "file";

export interface MediaAnswer {
  key: string;
  state: MediaState;
  /**
   * What the element loads now: the ticketed `/v3/c/` URL of the chosen variant, or a `data:` URL of cached bytes (a
   * small image, a PDF's page-1 thumbnail). Absent on a ready file the element cannot show (a PDF without thumbnail):
   * the frame shows a card with the name and size.
   */
  src?: string;
  /** The file's own ticketed `/v3/c/` URL (its original bytes, ranges served): what opens or reads it (a PDF's viewer). */
  url?: string;
  /** A PDF's prepared text (the owner's `text` variant, step 15): what the viewer's find and contents read. */
  textUrl?: string;
  kind?: MediaKind;
  /** A video's poster (cached by hash, as a `data:` URL). */
  poster?: string;
  durationMs?: number;
  size?: number;
  /** The video variant `src` plays. */
  variant?: VariantName;
  /** Both video variants' URLs and bitrates, for the two-stalls switch. */
  sources?: Partial<Record<VariantName, { src: string; bitrate?: number }>>;
  /** "preview", or "original · may buffer" (§9A.5). */
  badge?: string;
  /** The words after 1 s without a first frame ("loading · via tailnet"). */
  pathLabel?: string;
  /** This device's choice in the player menu. */
  choice?: Choice;
}

export type FrameMediaMessage =
  | { botling3: "media.want"; items: MediaWant[] }
  /**
   * An element showing `src` of `key` failed (`error`: an error event, after which the frame dropped the source) or
   * sits stalled without bytes (`stalled`: WebKit's loader never fires `error` on a refused range, see the step 11
   * evidence). The shell asks the server again, at most once per failure and with a back-off.
   */
  | { botling3: "media.failed"; key: string; reason?: "error" | "stalled"; src?: string }
  /** `bytes` of a playing video arrived in `ms` (the frame's measure of this session's rate). */
  | { botling3: "media.rate"; bytes: number; ms: number }
  /** The frame switched `key` to the preview: the playing original stalled twice in 30 s, or did not start (WebKit). */
  | { botling3: "media.switched"; key: string; why?: "stalls" | "slow-start" }
  /** The device's choice in the player menu (kept per device by the shell). */
  | { botling3: "media.choice"; choice: Choice }
  /** The person tapped a ready PDF (its page-1 thumbnail or its card): the shell opens the viewer (step 15). */
  | { botling3: "media.open"; key: string };

export type ShellMediaMessage = { botling3: "media"; items: MediaAnswer[] };

export const mediaKey = (botId: string, line: string, url: string): string => `${botId}\n${line}\n${url}`;

/** Whether the bot's URL names a local file (what the server indexes): a file:// URL or an absolute path. */
export const isLocalMedia = (url: string): boolean => /^file:\/\//i.test(url) || (url.startsWith("/") && !url.startsWith("//"));

/** The words a line shows instead of a file that changed after it (protocol v1 §9A.3). */
export const CHANGED_TEXT = "This file changed after this message.";
export const GONE_TEXT = "This file is no longer kept.";
export const FAILED_TEXT = "This file could not be loaded here.";

/** The kind of a file by its MIME type. */
export function kindOfType(type: string): MediaKind {
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return "file";
}
