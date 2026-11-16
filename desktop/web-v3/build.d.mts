export interface BuildPageOptions { out?: string; development?: boolean; /** The build ships no in-page plugin: its manifest lists none (the shell-alone acceptance page). */ noPlugins?: boolean }
export function buildPage(options?: BuildPageOptions): Promise<{ out: string; id: string }>;
