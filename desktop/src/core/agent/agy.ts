import type { BrowserToolName } from "../../browser-bot";
export const AGY_EXECUTION_BLOCKED = "Antigravity execution is blocked: the CLI has no verified pre-task policy barrier. No process or task was started. Choose another engine until a safe transport is available.";
export interface AgyConfig {
  command: string;
  /** Explicit Antigravity-only user selection, captured for this head. */
  bypassPermissions?: boolean;
  /** App-owned ACP profile; never the global CLI configuration. */
  acpHome?: string;
  transport?: "acp";
  worker?: boolean;
  workerEngine?: "agy" | "codex";
  /** A worker's app_notify_owner, from its run under way (its core's `notifyOwner`); absent: the worker has no such tool. */
  workerNotify?: (args: Record<string, unknown>) => unknown;
  /** The in-app browser tools (core/browser-tools.ts), for this bot's pane; its workers inherit it. */
  browser?: (name: BrowserToolName, args: Record<string, unknown>) => Promise<unknown>;
  /** Model families whose workers may write spec/ (settings.json `specWriters`; default ["opus"]). Bot heads are not restricted. */
  specWriters?: readonly string[];
  processStarted?: (pid: number) => void;
  canStartReport?: () => boolean;
  prefixArgs?: string[];
  cwd: string;
  /** More folders the file tools may use: the project's `.bot` when the session starts in an app worktree. */
  addDirs?: string[];
  env?: Record<string, string | undefined>;
  sessionId: string;
  resume: boolean;
  model?: string | null;
  effort?: string | null;
  /**
   * The bot's own choice for its Antigravity workers, read as each one starts (settings: Antigravity workers' model
   * and effort). A value left null is the head's (`model`, `effort`). Codex workers of this head do not use it.
   */
  workerChoice?: () => { model?: string | null; effort?: string | null };
  systemPrompt?: string;
  /**
   * Plugins' skill folders (engine-skills.ts): written as the profile's `config/skills.json`, so this head and its workers
   * (which inherit them) load the skills natively. None: no skills.json.
   */
  skillRoots?: string[];
  /** Separate execution instructions; never inherit the coordinator policy. */
  workerInstructions?: string;
}
