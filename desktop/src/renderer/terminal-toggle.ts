export type TerminalToggle = "none" | "show" | "hide" | "open" | "show-and-open";

/**
 * What the terminal shortcut does for the shown bot. `shells` is how many shells its panel has, or undefined while the
 * panel is not mounted or still starting (a new panel opens its first shell itself). An empty panel opens a shell
 * instead of hiding or showing nothing; with shells it is the plain show/hide; a deleted bot gets nothing.
 */
export function terminalToggleAction(state: { botExists: boolean; visible: boolean; shells: number | undefined }): TerminalToggle {
  if (!state.botExists) return "none";
  if (state.shells === 0) return state.visible ? "open" : "show-and-open";
  return state.visible ? "hide" : "show";
}
