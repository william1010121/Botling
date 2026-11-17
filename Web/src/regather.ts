import { t } from "./i18n";

/** What "make a new component" on a worker card says to the card's worker (sent on the card's reply path): your suggestion follows if you typed one. */
export function newComponentText(suggestion: string): string {
  const words = suggestion.trim();
  return words ? `${t("card.new.message")}\n\n${t("card.new.suggestion")}${words}` : t("card.new.message");
}

/**
 * What "make it a visual report" on a reply says to the bot, as your own line (it quotes the reply): gather the
 * data behind that reply again and answer again as a report, then your suggestion if you typed one.
 */
export function regatherText(suggestion: string): string {
  const words = suggestion.trim();
  return words ? `${t("regather.message")}\n\n${t("regather.suggestion")}${words}` : t("regather.message");
}
