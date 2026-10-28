import { z } from 'zod';

export type Lang = 'zh-Hant' | 'en';

/** One status vocabulary for every block; the colour comes from the theme, never from the bot. */
export const statusEnum = z.enum(['done', 'active', 'pending', 'blocked', 'risk', 'unverified', 'skipped'])
  .describe('done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)');
export type Status = z.infer<typeof statusEnum>;
export const toneEnum = z.enum(['good', 'warn', 'bad', 'info', 'neutral']);
export type Tone = z.infer<typeof toneEnum>;

export const kinds = ['status', 'decision', 'investigation', 'comparison', 'plan', 'results', 'explainer'] as const;
export type Kind = typeof kinds[number];
export const levelEnum = z.enum(['on_track', 'at_risk', 'off_track', 'done', 'info']);
export type Level = z.infer<typeof levelEnum>;

const zh = {
  report: 'Botling 報告', asOf: '資料截至', verdict: '結論', next: '接下來', asks: '需要你', noAsk: '不需要你處理。',
  sources: '依據', by: '期限', owner: '負責', continued: '（續）', page: '頁', slides: '投影片', of: '/',
  pros: '優點', cons: '缺點', verdictLabel: '判斷', recommended: '建議', before: '之前', after: '之後',
  doneOf: (d: number, n: number) => `${d} / ${n} 完成`, total: '合計', unknown: '未知',
  brokenBlock: '這個區塊的資料有誤，無法顯示', items: (n: number) => `${n} 項`, now: '現在', today: '今天',
  status: { done: '完成', active: '進行中', pending: '待處理', blocked: '受阻', risk: '有風險', unverified: '未驗證', skipped: '略過' } as Record<Status, string>,
  level: { on_track: '順利', at_risk: '有風險', off_track: '落後', done: '已完成', info: '說明' } as Record<Level, string>,
  kind: { status: '進度報告', decision: '決策', investigation: '問題調查', comparison: '比較', plan: '計畫', results: '成果', explainer: '說明' } as Record<Kind, string>,
  example: '範例',
};
const en: typeof zh = {
  report: 'Botling report', asOf: 'As of', verdict: 'Bottom line', next: 'Next', asks: 'Needs you', noAsk: 'No action needed.',
  sources: 'Sources', by: 'by', owner: 'owner', continued: ' (cont.)', page: 'page', slides: 'Slides', of: '/',
  pros: 'Pros', cons: 'Cons', verdictLabel: 'Verdict', recommended: 'Recommended', before: 'Before', after: 'After',
  doneOf: (d, n) => `${d} of ${n} done`, total: 'Total', unknown: 'Unknown',
  brokenBlock: 'This block has invalid data and cannot be shown', items: n => `${n} item${n === 1 ? '' : 's'}`, now: 'Now', today: 'Today',
  status: { done: 'Done', active: 'In progress', pending: 'Pending', blocked: 'Blocked', risk: 'At risk', unverified: 'Unverified', skipped: 'Skipped' },
  level: { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Done', info: 'Info' },
  kind: { status: 'Status', decision: 'Decision', investigation: 'Investigation', comparison: 'Comparison', plan: 'Plan', results: 'Results', explainer: 'Explainer' },
  example: 'Example',
};
export const labels = { 'zh-Hant': zh, en };
export type Labels = typeof zh;

/** Status → tone class used by the stylesheet (colour lives only in CSS). */
export const statusTone: Record<Status, Tone> = { done: 'good', active: 'info', pending: 'warn', blocked: 'bad', risk: 'bad', unverified: 'neutral', skipped: 'neutral' };
export const levelTone: Record<Level, Tone> = { on_track: 'good', at_risk: 'warn', off_track: 'bad', done: 'good', info: 'info' };
