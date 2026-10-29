import type { SettingsView } from '../../contract';
type Status = SettingsView['agyPermissionSessions'][number];
/** Core-owned live heads only. No persisted grants, model arguments or cross-session approvals. */
const sessions = new Map<object, { status: Status; revoke(): void }>();
export function registerAgyPermissions(owner: object, status: Status, revoke: () => void) {
  for (const [key,entry] of sessions) if (entry.status.sessionId === status.sessionId && ["stopped","error"].includes(entry.status.state)) sessions.delete(key);
  sessions.set(owner, { status: {...status}, revoke });
}
export function updateAgyPermissions(owner: object, status: Partial<Status>) {
  const entry = sessions.get(owner); if (entry) Object.assign(entry.status, status);
}
export function agyPermissionSessions(): Status[] { return [...sessions.values()].map(s => ({...s.status})); }
export function forgetAgyPermissions(owner: object) { sessions.delete(owner); }
export function changeAgyPermissions(full: boolean) {
  for (const entry of sessions.values()) {
    if (entry.status.mode === (full ? 'yolo' : 'default') || ['stopped','error'].includes(entry.status.state)) continue;
    // Revocation is synchronous; process cleanup follows. A new head must negotiate again.
    entry.status.state = 'stopped';
    entry.revoke();
    entry.status.message = 'Permission setting changed. Tools revoked; continue the conversation to start a new session process.';
  }
}
