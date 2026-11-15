// On-demand fetch between servers (protocol v1 §16, D51).
export {
  classify, DENY, isDeniedPath, Limits, realInside,
  type BotId, type ClassifyInput, type ClassifyResult, type DenyPattern, type FetchWhat,
} from "./policy";
