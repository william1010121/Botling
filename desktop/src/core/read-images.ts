import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { attachmentKind } from './attachments';
import type { StepRecord } from './store/records';

/** An image-only Read can be reopened from its recorded source even when no result bytes were kept.
 * Keep missing sources in the view so the renderer reports unavailability instead of hiding OUT.
 * This same selection is the resource allowlist; arbitrary tool input is never file permission.
 */
export function readImagePaths(step: StepRecord): string[] {
  if (step.kind !== 'tool' || step.tool !== 'Read' || !step.done || step.failed || (step.output ?? '').trim()) return [];
  const image = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path) && attachmentKind(path) === 'image';
  const kept = (step.images ?? []).filter(image).filter(existsSync).slice(0, 20);
  if (kept.length) return kept;
  return image(step.detail) ? [step.detail] : [];
}

export function readImages(step: StepRecord) {
  return readImagePaths(step).map(path => ({ url: pathToFileURL(path).href, name: basename(path).slice(0, 400) }));
}
