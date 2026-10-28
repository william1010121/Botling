// Minimal shared validators for the native-editor request boundary.
// Keep this module independent of the full renderer/main/core contract.
import { z } from "zod";
import shared from "../../../Web/src/contract.json";

export const ContractId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);
/** The most a card's `ccb.save` keeps, shared with Swift's ComponentState.limit. */
export const CARD_SAVE_LIMIT: number = (shared as { saveLimit: number }).saveLimit;
/** The most a pasted or dropped file may be, as base64 text (about 30 MB of file). */
export const FILE_DATA_LIMIT = 40_000_000;
const id = ContractId;
const botId = ContractId;
export const CardSaveCommand = z.strictObject({ type: z.literal("card.save"), botId, messageId: id, cardId: id, data: z.string().max(CARD_SAVE_LIMIT) });
export const CardActionCommand = z.strictObject({
  type: z.literal("card.action"), botId, messageId: id, cardId: id,
  name: z.string().min(1).max(64).regex(/^[a-z][a-zA-Z0-9.]*$/), value: z.string().max(4_000),
});
export const EditorCardCommand = z.discriminatedUnion("type", [CardSaveCommand, CardActionCommand]);
