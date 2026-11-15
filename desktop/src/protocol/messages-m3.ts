// Botling 3 wire protocol v1: the messages M3 and later milestones add to the wire registry. They are kept apart
// from `MESSAGES` (M1 + M2) so the M1/M2 decoders and their callers stay as they were: `decodeFrame` refuses these as
// unsupported, `decodeWireFrame` (frame.ts) reads every message of both registries.
//
// - `rows`: a table stream's catch-up batch (§8.2, §10.2), server → FE and server ↔ server (table-rows.ts).
// - `prefs.have` / `prefs.ids` / `prefs.want` / `prefs.rows`: preference gossip (§4.7, §17), server ↔ server (prefs.ts).
// - `join.*`: pairing a server (§4.5), server ↔ server in a pairing session only (join.ts).
// - `fetch.*`: on-demand fetch between servers (§16, M5-05), server ↔ server only (fetch.ts).
import type { z } from "zod";
import { FETCH_MESSAGES } from "./fetch";
import { MESSAGES } from "./messages";
import { JoinChecked, JoinCodeMsg, JoinDeclined, JoinDone, JoinHello, JoinWelcome, JoinWrong } from "./join";
import { PrefsHave, PrefsIds, PrefsRows, PrefsWant } from "./prefs";
import { Rows } from "./table-rows";

export const M3_MESSAGES = {
  rows: Rows,
  "prefs.have": PrefsHave, "prefs.ids": PrefsIds, "prefs.want": PrefsWant, "prefs.rows": PrefsRows,
  "join.hello": JoinHello, "join.code": JoinCodeMsg, "join.wrong": JoinWrong, "join.checked": JoinChecked,
  "join.welcome": JoinWelcome, "join.done": JoinDone, "join.declined": JoinDeclined,
} as const;
export type M3MessageType = keyof typeof M3_MESSAGES;
export type M3Message = { [T in M3MessageType]: z.infer<(typeof M3_MESSAGES)[T]> }[M3MessageType];

/** Every message schema of the protocol so far (M1, M2, M3, M5 fetch), by its `t`. */
export const WIRE_MESSAGES = { ...MESSAGES, ...M3_MESSAGES, ...FETCH_MESSAGES } as const;
export type WireMessageType = keyof typeof WIRE_MESSAGES;
export type WireMessage = { [T in WireMessageType]: z.infer<(typeof WIRE_MESSAGES)[T]> }[WireMessageType];
export type WireMessageOf<T extends WireMessageType> = z.infer<(typeof WIRE_MESSAGES)[T]>;
