// On-demand fetch between servers (protocol v1 §16, D51).
export {
  classify, DENY, isDeniedPath, Limits, realInside,
  type BotId, type ClassifyInput, type ClassifyResult, type DenyPattern, type FetchWhat,
} from "./policy";
export { FETCH_RESUME_WINDOW_MS, FetchRequester, incomingDirName, type FetchFailure, type FetchPeer, type FetchRequesterOptions, type FetchResult } from "./requester";
