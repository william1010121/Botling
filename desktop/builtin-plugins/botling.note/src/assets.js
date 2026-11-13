// botling.note, image adapter layer. This is the ONLY place the note touches image storage.
//
// Images in a note are relative refs: `note-assets/<hash>.<ext>`. Everything goes through the host
// part (src/host.ts), which calls the app's api.notes.importAsset / assetUrls / localizeImages
// (app 2.6.0+; "files" permission). Older apps lack them: every function then degrades
// (import rejects, srcFor gives null so the UI shows a muted placeholder, localize is a no-op).

let host = null;
let botId = "";
export function initAssets(ccb, id) {
  host = ccb?.host ?? null;
  botId = id;
}

export let IMAGE_API_AVAILABLE = true; // flipped to false once the host reports the app lacks the API

export class ImageApiUnavailable extends Error {
  constructor() {
    super("Image import is not available in this app version.");
    this.name = "ImageApiUnavailable";
  }
}

const REF = /^(?:\.\/)?note-assets\/[0-9A-Za-z_-]+\.[0-9A-Za-z]+$/;
export const isNoteAssetRef = (ref) => REF.test(ref);

const call = async (method, params) => {
  if (!host) throw new ImageApiUnavailable();
  try {
    return await host.call(method, { botId, ...params });
  } catch (error) {
    if (/unavailable|not a function|unknown method/i.test(String(error?.message ?? error))) {
      IMAGE_API_AVAILABLE = false;
      throw new ImageApiUnavailable();
    }
    throw error;
  }
};

const OK_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
const MAX_RAW = 1_800_000; // the app takes up to 2.5 MB; stay well below

const toBase64 = async (blob) => {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
};

// Downscale / convert a too-large (or unsupported) picture to webp/jpg under MAX_RAW.
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  for (let round = 0; round < 6; round++) {
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    for (const [type, ext] of [["image/webp", "webp"], ["image/jpeg", "jpg"]]) {
      const blob = await new Promise((res) => canvas.toBlob(res, type, 0.85));
      if (blob && blob.type === type && blob.size <= MAX_RAW) return { blob, ext };
    }
    scale *= 0.7;
  }
  throw new Error("Image is too large.");
}

// File (from paste / drop) -> ref like `note-assets/<hash>.<ext>`.
export async function importImage(file) {
  if (!host) throw new ImageApiUnavailable();
  let blob = file;
  let ext = OK_TYPES[file.type];
  if (!ext || file.size > MAX_RAW) ({ blob, ext } = await shrink(file));
  const base = (file.name || "image").replace(/\.[^.]+$/, "").replace(/[^0-9A-Za-z_-]+/g, "-").slice(0, 40) || "image";
  const res = await call("importAsset", { data: await toBase64(blob), name: `${base}.${ext}` });
  if (!res || typeof res.ref !== "string") throw new Error("No ref returned.");
  if (typeof res.url === "string") cache.set(res.ref, res.url);
  return res.ref;
}

// Copy absolute-path / file:// images of the note into note-assets (app side). Never rejects.
// Returns { text, mtime } when the note was rewritten and saved, else null.
export async function localizeNote(base) {
  try {
    const res = await call("localizeImages", typeof base === "number" ? { base } : {});
    return res && res.saved && typeof res.text === "string" ? { text: res.text, mtime: res.mtime } : null;
  } catch {
    return null;
  }
}

// ref -> URL cache; lookups in the same tick go out as one assetUrls call.
const cache = new Map();
let pending = null;
const norm = (ref) => ref.replace(/^\.\//, "");

function lookup(ref) {
  if (!pending) {
    const batch = { refs: new Map() };
    pending = batch;
    queueMicrotask(async () => {
      pending = null;
      const refs = [...batch.refs.keys()];
      let urls = {};
      try {
        for (let i = 0; i < refs.length; i += 500) Object.assign(urls, await call("assetUrls", { refs: refs.slice(i, i + 500) }));
      } catch {
        urls = {};
      }
      for (const [r, waiters] of batch.refs) {
        const url = typeof urls[r] === "string" ? urls[r] : null;
        if (url) cache.set(r, url);
        for (const w of waiters) w(url);
      }
    });
  }
  return new Promise((resolve) => {
    const list = pending.refs.get(ref) ?? [];
    list.push(resolve);
    pending.refs.set(ref, list);
  });
}

// ref -> a URL the <img> can show, a Promise of one, or null when it can't be shown.
export function srcFor(ref) {
  if (/^https?:\/\//i.test(ref)) return ref; // plain remote picture, shown as-is (not backed up)
  if (!isNoteAssetRef(ref) || !host) return null;
  const r = norm(ref);
  return cache.get(r) ?? lookup(r);
}

// A ref the app just made (e.g. ccb.snapshot of a card) together with its URL: shown without asking assetUrls.
export function rememberAsset(ref, url) {
  if (isNoteAssetRef(ref) && typeof url === "string" && url) cache.set(norm(ref), url);
}
