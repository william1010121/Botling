// The owner's media jobs of `botlingd` (protocol v1 §9A.5, §9A.8, §9A.9; M2 step 10): video meta, posters and previews,
// image and PDF thumbnails, linearized PDFs, kept as variants (`content.variant`) under a 5 GB LRU. External tools are
// found on `PATH` (tools.ts); without ffmpeg there is no preview and `botlingd status` says why.
export { DEFAULT_VARIANTS_CAP_BYTES, MediaJobs, mediaKindOf, type MediaJobsOptions, type MediaKind, type MediaStore, type VariantFile } from "./jobs";
export { killLeftoverTool, runTool, ToolError, type RunOptions, type ToolRun } from "./run";
export { LINEARIZE_ABOVE_BYTES, THUMB_MAX_PX } from "./still";
export { findOnPath, findTools, toolNotes, toolsSummary, type MediaTools, type ToolName } from "./tools";
export {
  POSTER_MAX_PX, PREVIEW_ABOVE_BITRATE, PREVIEW_ABOVE_BYTES, PREVIEW_KEYFRAME_SECONDS, PREVIEW_MAX_HEIGHT, previewReason, probeVideo, type VideoMeta,
} from "./video";
