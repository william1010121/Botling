export function inlineTokens(css: string, from: string, onFile?: (file: string) => void): string;
export function buildKit(options?: { write?: boolean }): Promise<{ js: string; module: string; bytes: number; fresh: boolean }>;
