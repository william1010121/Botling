export interface RendererConfiguration { path: string; directory?: string; warning?: string }
export function rendererAppData(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, home?: string): string;
export function rendererConfigPath(appData: string): string;
export function validateRendererDirectory(directory: string): string;
export function readRendererConfiguration(appData: string): RendererConfiguration;
export function writeRendererConfiguration(appData: string, directory: string | null): string;
