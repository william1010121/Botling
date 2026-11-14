// The content path's local part of `botlingd` (protocol v1 §9A.2–§9A.4, §9A.7, D44): the files a finished line names
// are pinned, referenced in the entry's transaction, hashed in a worker thread, and served to Electron main through
// `content.find` / `content.open` on the local socket.
export { contentTypeOf, FILES_PER_LINE_LIMIT, isProtectedPath, namedFiles, pathOfFileRef, type ContentKind, type LineLike, type NamedFile } from "./files";
export { CHUNK_BYTES, Hasher, type HashResult } from "./hasher";
export { cloneFile, COPY_MAX_BYTES, pinFile, pinsDir, sameSig, statSig, sweepPins, type Pin, type PinKind, type PinOptions, type StatSig } from "./pin";
export {
  ContentService, finishedLine,
  type ContentAnswer, type ContentRequest, type ContentServiceOptions, type ContentStore, type PreparedFile, type PreparedLine,
} from "./service";
