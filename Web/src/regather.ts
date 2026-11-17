import { t } from "./i18n";

/**
 * What "make it a visual report" on a reply says to the bot, as your own line (it quotes the reply): gather the
 * data behind that reply again and answer again as a report, then your suggestion if you typed one.
 */
export function regatherText(suggestion: string): string {
  const words = suggestion.trim();
  return words ? `${t("regather.message")}\n\n${t("regather.suggestion")}${words}` : t("regather.message");
}
