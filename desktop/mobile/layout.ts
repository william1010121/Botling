// Botling Web's phone layout: at this width and below the left column is a drawer over the chat (web.css), always
// open (bot names and faces), never the desktop's folded strip of faces, whatever the desktop's own setting is.
export const PHONE_QUERY = '(max-width: 700px)';

export function phoneWidth(match: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(globalThis)): boolean {
  try { return match?.(PHONE_QUERY).matches ?? false; } catch { return false; }
}

/** The layout settings the renderer gets: on a phone the left column is never folded (the drawer shows it whole). */
export function phoneLayout<T extends { railCollapsed?: boolean }>(settings: T, phone: boolean): T {
  return phone && settings.railCollapsed ? { ...settings, railCollapsed: false } : settings;
}
