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
  systemPrompt?: string;
  /** Separate execution instructions; never inherit the coordinator policy. */
  workerInstructions?: string;
}
