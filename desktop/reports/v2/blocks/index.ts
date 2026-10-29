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

/** The block catalog. Adding a block = one file in blocks/ + one entry here. Order = prompt-doc order. */
export const blocks: AnyBlockDef[] = [
  prose, callout, kpi, bar, trend, donut, beforeafter, matrix, quadrant, timeline, roadmap,
  flowchart, flow, sequence, table, options, proscons, checklist, progress, steps, quote, image, sources,
];
export const registry = new Map(blocks.map(b => [b.type, b]));
