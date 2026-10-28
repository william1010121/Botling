import { z } from 'zod';
import { MobileError } from './transport';
export const Session = z.object({ principal: z.string().regex(/^[a-f0-9]{64}$/), csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(), botIds: z.array(z.string()).min(1) });
export type BrowserSession = z.infer<typeof Session>;
export async function sessionRequest(path: 'session' | 'logout', csrf?: string) {
  const response = await fetch(`/api/mobile/${path}`, { method: 'POST', credentials: 'same-origin', redirect: 'manual',
    signal: AbortSignal.timeout(15000), cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'X-Botling-Session': '1', ...(csrf ? { 'X-Botling-CSRF': csrf } : {}) } });
  if (response.type === 'opaqueredirect' || response.status === 401) throw new MobileError('Sign in with Google to continue. Drafts remain in this tab.', true);
  if (response.status === 403) throw new MobileError('This account is not authorized. Ask the owner to check access.', false, false, true);
  if (!response.ok) throw new MobileError('Sign-in is unavailable. Check the connection and try again.');
  return response.json();
}
// Draft text only. Never store Google tokens, bearer tokens, session cookies or CSRF values.
const DRAFTS = 'botling-mobile-drafts';
const DraftRecord = z.object({ principal: z.string(), drafts: z.record(z.string(), z.string().max(100000)) });
export function loadDrafts(principal: string): Record<string, string> {
  try { const raw = sessionStorage.getItem(DRAFTS); if (!raw || raw.length > 1_000_000) return {};
    const record = DraftRecord.parse(JSON.parse(raw));
    if (record.principal === principal) return record.drafts;
    sessionStorage.removeItem(DRAFTS);
  } catch { /* Storage may be blocked; retain memory-only drafts. */ }
  return {};
}
export function saveDrafts(principal: string, drafts: Record<string, string>) {
  try { const raw = JSON.stringify({ principal, drafts }); if (raw.length <= 1_000_000) sessionStorage.setItem(DRAFTS, raw); } catch { /* Private browsing/quota. */ }
}
export function clearDrafts() { try { sessionStorage.removeItem(DRAFTS); } catch { /* Storage may be blocked. */ } }
