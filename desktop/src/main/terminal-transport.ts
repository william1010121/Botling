import type { WebContents } from 'electron';
import type { TerminalEvent } from '../contract/terminal';
/** Accept a captured WebContents reference, never read a destroyed BrowserWindow's getter. */
export function sendTerminalEvent(contents: Pick<WebContents, 'isDestroyed' | 'send'> | undefined, event: TerminalEvent): boolean {
  if (!contents || contents.isDestroyed()) return false;
  try { contents.send('botling:terminal:event', event); return true; }
  catch (error) {
    // A native destruction race is expected during close. Other transport defects must surface.
    if (contents.isDestroyed()) return false;
    throw error;
  }
}
