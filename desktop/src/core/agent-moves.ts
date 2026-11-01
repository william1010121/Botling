// Pure move planning (A1.6): whether an agent may change owner, and how. An owner move ("owner") only changes which
// bot sees the agent's row and gets its reports; the agent keeps running on its host. A Claude subagent cannot change
// owner until A3 (claudeOwnerMoves): its work moves by the sub-bot hand-off instead ("handoff": handoff.md, a new sub bot).
import type { Engine } from "./heads";
import { isDetached, type AgentRecord, type BotRef } from "./agent-registry";
import { engineName, subBotEngine } from "./sub-bots";

/** A bot as planning needs it. */
export interface BotFacts {
  id: string;
  name: string;
  role: "main" | "manager" | "bot";
  /** A sub bot's project bot. */
  parent: string | null;
  maintainer: boolean;
  problem: string | null;
  folder: string;
  /** Its primary head, and every head it has. */
  engine: Engine;
  heads: Engine[];
}

export type MoveTarget = { kind: "bot"; botId: string } | { kind: "newSubBot"; name: string; note?: string } | { kind: "back" };

export interface MoveFacts {
  owner: BotFacts;
  host: BotFacts | null;
  /** The bot named by a `bot` target (null: there is no such bot now). */
  target?: BotFacts | null;
  /** The project bot of the owner (itself, or a sub bot's `parent`), for a new sub bot. */
  project?: BotFacts | null;
  /** A move of this agent is under way. */
  pending: boolean;
  claudeOwnerMoves: boolean;
}

export type MovePlan =
  | { mode: "owner" | "handoff"; to: BotRef; makeSubBot?: { parentId: string; name: string; engine: Engine; note: string } }
  | { refuse: string };

/**
 * A Claude subagent inside its parent's process (a sidechain) moves by the sub-bot hand-off, until A3 lets a
 * background one change owner. Every app-managed worker (Codex, Antigravity, a Claude worker process) changes owner.
 */
const sidechainHandoff = (rec: AgentRecord, facts: Pick<MoveFacts, "claudeOwnerMoves">) =>
  rec.host.kind === "claude-sidechain" && !(rec.background && facts.claudeOwnerMoves);

/** Why this agent cannot move at all (null: it can, somewhere). */
export function unmovable(rec: AgentRecord, facts: Pick<MoveFacts, "owner" | "pending" | "claudeOwnerMoves">): string | null {
  if (rec.state === "lost") return "Its host is gone, so it cannot be moved.";
  if (facts.pending) return "A move of it is still under way.";
  if (sidechainHandoff(rec, facts)) {
    // The hand-off makes a sub bot under the bot that holds it.
    if (facts.owner.role === "main" || facts.owner.maintainer) return "The main bot's and Maintainer's Claude subagents cannot move.";
    if (facts.owner.parent) return "A sub bot's Claude subagent cannot move: a sub bot cannot make another sub bot.";
  }
  return null;
}

export function planMove(rec: AgentRecord, to: MoveTarget, facts: MoveFacts): MovePlan {
  const blocked = unmovable(rec, facts);
  if (blocked) return { refuse: blocked };
  const claudeHandoff = sidechainHandoff(rec, facts);
  if (to.kind === "back" || (to.kind === "bot" && to.botId === rec.host.botId && to.botId !== facts.owner.id)) {
    if (!isDetached(rec)) return { refuse: `It is already with ${facts.owner.name}.` };
    if (!facts.host) return { refuse: "Its host is gone, so it cannot be moved." };
    return { mode: "owner", to: { botId: rec.host.botId, engine: rec.host.engine } };
  }
  if (to.kind === "bot") {
    const target = facts.target ?? null;
    if (!target) return { refuse: "There is no such bot." };
    if (target.id === facts.owner.id) return { refuse: `It already belongs to ${target.name}.` };
    if (target.role === "main") return { refuse: "The main bot cannot take agents." };
    if (target.maintainer) return { refuse: "Maintainer cannot take agents." };
    if (target.problem) return { refuse: `${target.name} cannot run now: ${target.problem}` };
    if (claudeHandoff) return { refuse: "A Claude subagent can only move into a new sub bot: its work is handed over through handoff.md." };
    return { mode: "owner", to: { botId: target.id, engine: target.engine } };
  }
  // A new sub bot.
  const name = to.name.trim();
  if (!name) return { refuse: "A new sub bot needs a name." };
  if (facts.owner.role === "main" || facts.owner.maintainer) return { refuse: "The main bot and Maintainer have no sub bots." };
  if (claudeHandoff) {
    // The hand-off makes the sub bot under the bot that holds the subagent (the owner, for Claude).
    if (facts.owner.parent) return { refuse: "A sub bot cannot make another sub bot." };
    return { mode: "handoff", to: { botId: "", engine: facts.owner.engine } };
  }
  // Sub bots cannot make sub bots: one owned by a sub bot gets a sibling under the same project bot.
  const project = facts.project ?? null;
  if (!project) return { refuse: "Its project bot is gone." };
  if (project.problem) return { refuse: `${project.name} cannot run now: ${project.problem}` };
  // On the agent's own engine when the project bot has it, so a later host move (A4) can take it in.
  const chosen = subBotEngine(rec.engine, { engine: project.engine, heads: project.heads });
  return { mode: "owner", to: { botId: "", engine: chosen.engine }, makeSubBot: { parentId: project.id, name, engine: chosen.engine, note: chosen.note } };
}

/** "Codex", "Antigravity", "Claude". */
export const agentEngineName = (engine: Engine) => engineName(engine);
