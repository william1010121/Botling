import { z } from 'zod';
// Draft text only. Never store bearer tokens.
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
