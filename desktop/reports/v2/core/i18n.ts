import { z } from 'zod';

export type Lang = 'zh-Hant' | 'en';

/** One status vocabulary for every block; the colour comes from the theme, never from the bot. */
export const statusEnum = z.enum(['done', 'active', 'pending', 'blocked', 'risk', 'unverified', 'skipped'])
  .describe('done=完成(green) active=進行中(blue) pending=待處理(orange) blocked=受阻(red) risk=有風險(red) unverified=未驗證(grey) skipped=略過(faint)');
export type Status = z.infer<typeof statusEnum>;
export const toneEnum = z.enum(['good', 'warn', 'bad', 'info', 'neutral']);
export type Tone = z.infer<typeof toneEnum>;

export const kinds = ['status', 'decision', 'investigation', 'comparison', 'plan', 'results', 'explainer', 'experiment'] as const;
export type Kind = typeof kinds[number];
export const expVerdictEnum = z.enum(['supported', 'not_supported', 'inconclusive']);
export type ExpVerdict = z.infer<typeof expVerdictEnum>;
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
  kind: { status: '進度報告', decision: '決策', investigation: '問題調查', comparison: '比較', plan: '計畫', results: '成果', explainer: '說明', experiment: '實驗報告' } as Record<Kind, string>,
  example: '範例', notRun: '未跑：', overview: '現在在做什麼', ov: { question: '研究問題', compare: '在比什麼', setup: '資料與設定', complete: '怎樣算訓練完成', why: '為什麼重要' }, impact: '影響', risk: '最大風險', mitigation: '因應', glossary: '名詞解釋',
  exp: { question: '要回答的問題', hypothesis: '假設', success: '成功標準（事先定）', baseline: '比較基準', tunedYes: '同等調參', tunedNo: '未確認同等調參', runs: '重複次數', runsN: (n: number) => `每個設定 ${n} 次`, spread: '「±」代表', result: '結果', diff: '差距', ci: '95% 信賴區間', noise: '差距在誤差範圍內：不顯著', verdict: '判定' },
  expVerdict: { supported: '假設成立', not_supported: '假設不成立', inconclusive: '還不能判定' } as Record<ExpVerdict, string>,
};
const en: typeof zh = {
  report: 'Botling report', asOf: 'As of', verdict: 'Bottom line', next: 'Next', asks: 'Needs you', noAsk: 'No action needed.',
  sources: 'Sources', by: 'by', owner: 'owner', continued: ' (cont.)', page: 'page', slides: 'Slides', of: '/',
  pros: 'Pros', cons: 'Cons', verdictLabel: 'Verdict', recommended: 'Recommended', before: 'Before', after: 'After',
  doneOf: (d, n) => `${d} of ${n} done`, total: 'Total', unknown: 'Unknown',
  brokenBlock: 'This block has invalid data and cannot be shown', items: n => `${n} item${n === 1 ? '' : 's'}`, now: 'Now', today: 'Today',
  status: { done: 'Done', active: 'In progress', pending: 'Pending', blocked: 'Blocked', risk: 'At risk', unverified: 'Unverified', skipped: 'Skipped' },
  level: { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Done', info: 'Info' },
  kind: { status: 'Status', decision: 'Decision', investigation: 'Investigation', comparison: 'Comparison', plan: 'Plan', results: 'Results', explainer: 'Explainer', experiment: 'Experiment' },
  example: 'Example', notRun: 'Not run: ', overview: 'What we are doing', ov: { question: 'Question', compare: 'Comparison', setup: 'Data and setup', complete: 'Complete training', why: 'Why it matters' }, impact: 'Impact', risk: 'Biggest risk', mitigation: 'Response', glossary: 'Terms',
  exp: { question: 'Question', hypothesis: 'Hypothesis', success: 'Success criterion (set before)', baseline: 'Baseline', tunedYes: 'equally tuned', tunedNo: 'equal tuning not confirmed', runs: 'Runs', runsN: n => `${n} per setting`, spread: '"±" means', result: 'Result', diff: 'Difference', ci: '95% CI', noise: 'Within the noise: not significant', verdict: 'Verdict' },
  expVerdict: { supported: 'Hypothesis supported', not_supported: 'Hypothesis not supported', inconclusive: 'Inconclusive' },
};
export const labels = { 'zh-Hant': zh, en };
export type Labels = typeof zh;

/** Status → tone class used by the stylesheet (colour lives only in CSS). */
export const statusTone: Record<Status, Tone> = { done: 'good', active: 'info', pending: 'warn', blocked: 'bad', risk: 'bad', unverified: 'neutral', skipped: 'neutral' };
export const levelTone: Record<Level, Tone> = { on_track: 'good', at_risk: 'warn', off_track: 'bad', done: 'good', info: 'info' };
