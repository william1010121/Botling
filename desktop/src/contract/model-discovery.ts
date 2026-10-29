/** Runtime-reported choices, not a guarantee that a later inference request will succeed. */
export type ModelEngine = 'claude' | 'codex' | 'agy';
export interface DiscoveredModel { id: string; name: string; isDefault: boolean; efforts: string[] | null }
export interface ModelDiscovery {
  status: 'ready' | 'signed-out' | 'unsupported' | 'unavailable' | 'error';
  models: DiscoveredModel[];
  source: string;
  message: string;
}
