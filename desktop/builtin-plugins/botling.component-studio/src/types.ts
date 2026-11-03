// What the plugin's web part draws from: the chip of a spec under its reply (`SpecChipView`, the Board plugin's pin button reads it too, so
// it stays the chat page's) and the spec in the right panel (`SpecState`, Swift's `SpecPayload`, which only this plugin draws).
import type { CommandStatus, ComponentInfo, PinRefresh, SampleKind, SpecOrigin } from "../../../../Web/src/types";

export type { ChatState, ComponentInfo, PinRefresh, SpecChipView, SpecOrigin, SpecStatus } from "../../../../Web/src/types";

export interface SpecChange {
  state: "working" | "asking" | "updated" | "failed";
  version: number;
  /** Milliseconds since 1970. */
  startedAt: number;
  endedAt?: number | null;
  error?: string | null;
  /** The panel's id for the request that started it (`say`'s `request`). */
  request?: string | null;
}

export interface SpecState {
  id: string;
  name: string;
  about: string;
  status: "draft" | "building" | "done";
  draft: number;
  /** The chat it is in. */
  chat: string;
  /** "from Botling's reply at 22:14", "suggested by garden". */
  from: string;
  suggestedBy: string | null;
  /** The reply already is this component: only which bots get it is left. */
  existing: string | null;
  fields: { name: string; type: string; by: SpecOrigin }[];
  command: string | null;
  folder: string;
  refresh: PinRefresh;
  minutes: number;
  bots: { name: string; on: boolean }[];
  similar: string | null;
  similarAbout: string | null;
  reuse: boolean;
  /** `kind`: the app's own samples ("testRun", "reply", "page"); null for Maintainer's. The label is only what the tab says. */
  samples: { label: string; kind: SampleKind | null; data: string }[];
  /** The sample shown until you pick one (the app decides: the real run for live data, else the reply's own). */
  preferredSample: number | null;
  questions: { id: string; text: string; options: { label: string }[]; suggested: number | null }[];
  /** `images`: pictures in Maintainer's words (a component shot's contact sheet), as file URLs. */
  conversation: { kind: "user" | "maintainer" | "event"; text: string; images?: string[] }[];
  /** Who last set each value: blue for the user, purple for Maintainer. */
  origins: Record<string, SpecOrigin>;
  /** The library component whose template draws the preview; null: a plain drawing of the data. */
  preview: string | null;
  components: Record<string, ComponentInfo>;
  /** Its command's test run, as a command card shows one. */
  testRun: { status: CommandStatus; command: string; folder: string; output: string | null; error: string | null; ranAt: string | null; matches: boolean | null } | null;
  /** While building and once done: what has happened. */
  steps: { label: string; state: "done" | "doing" | "todo" | "failed" }[] | null;
  /** The version in the library once built (1 after the first build). */
  version?: number | null;
  /** A change asked for once built: Maintainer making `version`, its one question, landed, or not. */
  change?: SpecChange | null;
  /** What was typed during a build: it goes with the next change. */
  queued?: string[] | null;
  wide: boolean;
  /** The language of the panel's own words, as `ChatState.lang`. */
  lang?: string | null;
}
