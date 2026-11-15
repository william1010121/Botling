// Shared Electron main-process detection and minimal interfaces for Botling 3 (`main-v3` + `server`), so neither
// checks `app.isPackaged` independently and non-Electron Node runs avoid loading Electron APIs unless present.

export interface ElectronPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown; ports?: ElectronPortLike[] }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

export interface ElectronUtilityProcessLike {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "spawn", listener: () => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  once(event: "error", listener: (type: string, location: string, report: string) => void): unknown;
  // Electron's MessagePortMain transfer array is structurally narrower than ElectronPortLike; keep transfer bivariant-safe.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postMessage(message: unknown, transfer?: any[]): void;
  kill(): boolean;
}

export interface ElectronUtilityForkOptions {
  serviceName?: string;
  stdio?: "pipe" | "inherit" | "ignore" | Array<"pipe" | "inherit" | "ignore">;
  env?: Record<string, string>;
  cwd?: string;
}

export interface ElectronUtilityContext {
  utilityProcess: {
    fork(modulePath: string, args?: string[], options?: ElectronUtilityForkOptions): ElectronUtilityProcessLike;
  };
  MessageChannelMain: new () => { port1: ElectronPortLike; port2: ElectronPortLike };
}

export interface ElectronMainLike {
  app?: {
    isPackaged?: boolean;
    isReady?: () => boolean;
    whenReady?: () => Promise<void>;
    setActivationPolicy?: (policy: "regular" | "accessory" | "prohibited") => void;
    dock?: { hide?: () => void };
  };
  utilityProcess?: ElectronUtilityContext["utilityProcess"];
  MessageChannelMain?: ElectronUtilityContext["MessageChannelMain"];
}

export function loadElectron(): ElectronMainLike | undefined {
  if (!process.versions.electron) return undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("electron") as ElectronMainLike | string;
    return typeof mod === "object" && mod !== null ? mod : undefined;
  } catch {
    return undefined;
  }
}

export function isPackagedElectron(electron: ElectronMainLike | undefined = loadElectron()): boolean {
  return electron?.app?.isPackaged === true;
}

export function electronUtilityOf(electron: ElectronMainLike | undefined): ElectronUtilityContext | undefined {
  return electron?.utilityProcess && electron?.MessageChannelMain
    ? { utilityProcess: electron.utilityProcess, MessageChannelMain: electron.MessageChannelMain }
    : undefined;
}
