export const CORE_FIXED_PLUGINS: readonly string[];
export function contentHash(dir: string): string;
export interface Placed { dir: string; folder: string; hash: string; changed: boolean }
export function placeOverride(options: { built: string; name: string; root: string; now?: number }): Placed;
export function removeOverride(options: { name: string; root: string }): void;
export function pushBuiltinPlugin(options: {
  name: string;
  desktopDir: string;
  dataDir: string;
  build?: (name: string) => Promise<string>;
  check?: (folder: string) => string[];
  now?: number;
  log?: (line: string) => void;
}): Promise<Placed>;
export function defaultDataDir(env?: Record<string, string | undefined>, home?: string): string;
