import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { firstParagraph, markdownBullets, renderMarkdown, textUnits } from '../core/text';
import { Md } from '../core/ui';

export const prose = defineBlock({
  type: 'prose',
  description: 'A short paragraph or bullet list in restricted Markdown (**bold**, *italic*, `code`, - bullets, 1. numbers).',
  when: 'Reasoning that a chart cannot carry: why, so what, caveats. 2–4 sentences or ≤5 bullets. Not for data (use a chart) and not for a chronological log.',
  fields: {
    text: z.string().trim().min(1).max(1200).describe('Restricted Markdown. No headings, links, images or HTML.'),
    slide: z.string().trim().min(1).max(160).optional().describe('One-sentence version for slides; defaults to the first paragraph.'),
  },
  examples: [{ text: '閒置 CPU 從 **9.8%** 降到 **2.1%**，主要來自停掉背景輪詢。\n\n- 只在視窗可見時更新側欄\n- 子程序改為事件喚醒' }],
  fit: 'text',
  visual: false,
  Doc: ({ block }) => <div className="blk blk-prose"><Md html={renderMarkdown(block.text)}/></div>,
  Slide: ({ block }) => <div className="blk blk-prose"><Md html={renderMarkdown(block.slide ?? firstParagraph(block.text))}/></div>,
  slide: {
    weight: b => Math.min(1, 0.12 + textUnits(b.slide ?? firstParagraph(b.text)) / 220 + markdownBullets(b.slide ?? firstParagraph(b.text)).count * 0.08),
    side: true,
  },
});
