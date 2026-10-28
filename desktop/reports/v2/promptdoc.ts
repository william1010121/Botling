import { z } from 'zod';
import { blocks } from './blocks';
import { budgets } from './lint';
import { minimalExample, reportSpecSchema } from './spec';
import type { Kind } from './core/i18n';

/** JSON Schema of the whole ReportSpec v2, generated from the registry. */
export function jsonSchema(): object {
  return z.toJSONSchema(reportSpecSchema, { io: 'input', unrepresentable: 'any' });
}

/** Report skeletons from the writing handbook: per kind, which sections and blocks, in order. */
export const skeletons: Record<Kind, { purpose: string; sections: string[] }> = {
  status: { purpose: 'Where things stand and what needs attention.', sections: ['tldr + status.level (at_risk/off_track need status.reason: cause + fix)', 'kpi (target vs actual, delta, spark) — stack:true for status counts', 'checklist or table (Done / Next / Blocked) or flow (where each item is stuck)', 'timeline (milestones) or roadmap (now/next/later) — optional', 'asks (owner, deadline) — or [] for "No action needed"'] },
  decision: { purpose: '"Decision needed: X by date" with a recommendation.', sections: ['tldr = the recommendation + the deadline', 'prose: context in SCQA, 2–3 sentences', 'options (2–4 incl. "do nothing", same criteria: cost, risk, time, reversibility) with recommended + verdict', 'proscons or quadrant (effort × impact) — why the others lose', 'callout tone=warn: the main risk / assumption', 'asks: who decides, by when'] },
  investigation: { purpose: 'What broke, why, and whether it is fixed.', sections: ['tldr = impact + fixed now? + the cause in one sentence', 'timeline (events) — what happened when', 'flow or sequence — the causal chain, failing step status=blocked', 'beforeafter or trend — the metric before/after the fix', 'checklist — actions with owners (blameless)', 'sources ≤ 4'] },
  comparison: { purpose: 'Which one, and "pick X if…, Y if…".', sections: ['tldr = the winner + when to pick the other', 'options or table with the winning cells toned good', 'bar (small multiples via one bar per criterion) — optional', 'callout: caveats'] },
  plan: { purpose: 'Goal, definition of done, path there.', sections: ['tldr = goal + definition of done + date', 'timeline (gantt with lanes, today) or roadmap', 'flow — dependencies / critical path', 'callout tone=bad for the top risk', 'steps — the first step; asks — decision needed'] },
  results: { purpose: 'What the numbers say after a change.', sections: ['tldr = headline number + what it means', 'kpi vs baseline (delta, target)', 'trend with marks at the change, target line', 'beforeafter or bar — segment breakdown', 'prose: interpretation with likelihood words + %', 'sources ≤ 4'] },
  explainer: { purpose: 'What it is and how it works.', sections: ['tldr = one sentence what + why', 'flow or sequence — the mechanism', 'steps or table — 3–5 concepts', 'image — a worked example', 'callout — limits'] },
};

const short = (v: unknown): string => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.startsWith('data:image/') ? 'data:image/svg+xml;base64,…' : x));

function fieldLines(schema: Record<string, any>, indent = ''): string[] {
  const props: Record<string, any> = schema.properties ?? {};
  const req = new Set<string>(schema.required ?? []);
  const summarise = (p: any): string => {
    if (!p) return 'any';
    if (p.const !== undefined) return JSON.stringify(p.const);
    if (p.enum) return p.enum.map((e: unknown) => JSON.stringify(e)).join(' | ');
    if (p.anyOf || p.oneOf) return (p.anyOf ?? p.oneOf).map(summarise).join(' | ');
    if (p.type === 'array') {
      const lim = [p.minItems !== undefined && `≥${p.minItems}`, p.maxItems !== undefined && `≤${p.maxItems}`].filter(Boolean).join(' ');
      if (p.prefixItems) return `[${p.prefixItems.map(summarise).join(', ')}]`;
      return `${summarise(p.items)}[]${lim ? ` (${lim})` : ''}`;
    }
    if (p.type === 'object') return `{ ${Object.keys(p.properties ?? {}).map(k => `${k}${(p.required ?? []).includes(k) ? '' : '?'}`).join(', ')} }`;
    if (p.type === 'string') return `string${p.maxLength ? ` ≤${p.maxLength}` : ''}`;
    if (p.type === 'number' || p.type === 'integer') return `${p.type}${p.minimum !== undefined ? ` ≥${p.minimum}` : ''}${p.maximum !== undefined ? ` ≤${p.maximum}` : ''}`;
    if (p.type === 'boolean') return 'boolean';
    return 'any';
  };
  return Object.entries(props).filter(([k]) => k !== 'type' && k !== 'span').flatMap(([k, p]) => {
    const line = `${indent}- \`${k}${req.has(k) ? '' : '?'}\`: ${summarise(p)}${p.description ? ` — ${p.description}` : ''}`;
    const inner = p.type === 'array' ? p.items : p;
    const nested = !indent && inner?.type === 'object' && inner.properties ? fieldLines(inner, indent + '  ') : [];
    return [line, ...nested];
  });
}

export function promptDoc(): string {
  const out: string[] = [];
  out.push('# Botling report blocks (ReportSpec v2)', '');
  out.push('> Generated from `desktop/reports/v2/blocks` by `node desktop/scripts/report.mjs --docs`. Do not edit by hand.', '');
  out.push('A report is JSON: header + `tldr` + `sections[] → blocks[]` + `asks`. You pick the blocks; layout, colours, fonts and the slide version are decided by the renderer. Write key points only.', '');
  out.push('## Rules', '');
  out.push('1. **Answer first.** `tldr` ≤ 3 sentences states the conclusion; `next` ≤ 3 one-line steps.',
    '2. **Headline = takeaway.** Every section has `takeaway`: its conclusion as one sentence (≈ 22 CJK chars / 15 words). Reading only takeaways gives the argument. `title` is the short topic label.',
    '3. **One idea per section, ≤ 2 charts per section, ≤ 8 in the report.** Visuals for data, prose for reasoning, bullets only for lists (≤ 6, ≤ 2 levels).',
    '4. **Every chart has an action title** (`title`: what it shows, not what it is) and direct labels; never repeat a KPI as a chart.',
    '5. **Evidence is short.** One line per claim (number + source); ≤ 4 `sources`; long logs stay out of the report. Never hide a risk or a decision in detail.',
    '6. **Uncertainty with words + %:** almost certain 95–99, very likely 80–95, likely 55–80, roughly even 45–55, unlikely 20–45, very unlikely 5–20. Mark verified vs inferred vs not checked.',
    '7. **End with `asks`** (what, who, by) — or `"asks": []` for "No action needed". `status.level` at_risk / off_track needs `status.reason` (cause + fix).',
    '8. **Forbidden:** topic-only headings, narrating your process chronologically, the conclusion at the end, evidence dumps, decorative charts, one-sided options, vague hedging, mixing report kinds.', '');
  out.push('## Generate', '', '```sh', 'node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report.html          # document (no JavaScript)', 'node desktop/scripts/report.mjs spec.json /abs/.bot/artifacts/report-slides.html --slides  # 16:9 slides', '```', '');
  out.push('The CLI prints one JSON line: `{"ok", "errors": [{path, message, example}], "warnings": [{path, message}], "htmlPath", "link"}`. Fix every error (the `example` is a valid block of that type); fix warnings when you can, then render again (≤ 2 retries). A block with errors renders as a visible placeholder; the rest of the report still renders. Put `link` in your reply.', '');
  out.push('## Spec', '', '```json', JSON.stringify(minimalExample, null, 2), '```', '');
  out.push(...fieldLines((jsonSchema() as any)), '- section: `{ id?, title, takeaway?, layout?: "auto"|"stack"|"split"|"grid", blocks[] (≤8) }` — keep `layout` on auto unless you have a reason.', '');
  out.push('## Report kinds', '', 'Pick one `kind`; use its skeleton as the default section order (skip what you have no evidence for).', '');
  for (const [kind, s] of Object.entries(skeletons)) {
    out.push(`### ${kind}`, '', s.purpose, '', ...s.sections.map((x, i) => `${i + 1}. ${x}`), '');
  }
  out.push('## Blocks', '', 'Every block takes optional `title` (action title), `note` (faint caption: unit, scope, source) and `span: "full"`. Statuses everywhere: `done | active | pending | blocked | risk | unverified | skipped`. Tones: `good | warn | bad | info | neutral`.', '');
  out.push(`| type | use for |`, `|---|---|`, ...blocks.map(b => `| \`${b.type}\` | ${b.description.replace(/\|/g, '/')} |`), '');
  for (const b of blocks) {
    const js = z.toJSONSchema(b.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, any>;
    out.push(`### \`${b.type}\``, '', b.description, '', `**When:** ${b.when}`, '', ...fieldLines(js), '', '```json', short(b.examples[0]), '```', '');
  }
  out.push('## Lint budgets', '', ...Object.entries(budgets).map(([k, v]) => `- \`${k}\`: ${v}`), '');
  return out.join('\n');
}
