import type { AnyBlockDef } from '../core/registry';
import { prose } from './prose';
import { callout } from './callout';
import { kpi } from './kpi';
import { bar } from './bar';
import { trend } from './trend';
import { donut } from './donut';
import { beforeafter } from './beforeafter';
import { matrix } from './matrix';
import { quadrant } from './quadrant';
import { timeline } from './timeline';
import { roadmap } from './roadmap';
import { flowchart, flow } from './flow';
import { sequence } from './sequence';
import { table } from './table';
import { options, proscons } from './options';
import { checklist } from './checklist';
import { progress } from './progress';
import { steps } from './steps';
import { quote } from './quote';
import { image } from './image';
import { sources } from './sources';
import { glossary } from './glossary';
import { experiment } from './experiment';
import { figure } from './figure';

/** The block catalog. Adding a block = one file in blocks/ + one entry here. Order = prompt-doc order. */
export const blocks: AnyBlockDef[] = [
  prose, callout, glossary, experiment, kpi, bar, trend, donut, beforeafter, matrix, quadrant, timeline, roadmap,
  flowchart, flow, sequence, table, figure, options, proscons, checklist, progress, steps, quote, image, sources,
];
export const registry = new Map(blocks.map(b => [b.type, b]));
/**
 * Native data-chart blocks that bots no longer pick: every data chart is a `figure` (matplotlib reading the result files). The
 * renderer still draws them so older specs render, with a warning (lint.ts); the guide (promptdoc.ts) leaves them out. `matrix`
 * stays for its placement grid; a matrix with numbers (a heatmap) gets the same warning.
 */
export const retiredCharts = new Set(['bar', 'trend', 'donut', 'beforeafter', 'quadrant']);
/** The blocks the guide offers, in prompt-doc order. */
export const guideBlocks: AnyBlockDef[] = blocks.filter(b => !retiredCharts.has(b.type));
