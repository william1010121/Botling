// A pin book over a fake Botling: what `api.cards` answers (the library, the components a chat shows, a card's command run and its ask),
// and where the pins are stored and published. Enough to see each rule the core's Bot had for pins, now the plugin's.
import type { CardLibrary, CardState, ShownCard } from "../../../../Web/host/src/api";
import { PinBook, type BookHost } from "../src/pinbook";
import type { PinRecord } from "../src/pin-data";
import type { BoardData } from "../src/types";

export const BOT = "6A0B0000-0000-4000-8000-000000000002";
export const FOLDER = "/work/site";

export class FakeBotling {
  /** The commands the user allowed (in FOLDER), and the component each library entry has. */
  approved = new Set<string>();
  details = new Map<string, string>();
  entries: Record<string, { command: string | null; detail: string | null; every: number | null; sizes: string[] }> = {};
  shownCards: ShownCard[] = [];
  readOnly = false;
  /** Runs asked for, in order (card, command, force); each card's last run. */
  runs: { card: string; command: string; force: boolean }[] = [];
  lastRuns = new Map<string, { command: string; status: "done" | "running"; data: string | null; ranAt: number }>();
  lastRan = new Map<string, number>();
  stored = new Map<string, unknown[]>();
  legacy: unknown[] | null = null;
  published: { botId: string; data: BoardData }[] = [];
  notes: { botId: string; notes: { date: number; line: string }[] }[] = [];
  libraryCalls = 0;
  clock = 1_800_000_000_000;

  library(): CardLibrary {
    return { botId: BOT, names: Object.keys(this.entries), offered: Object.keys(this.entries), entries: this.entries, readOnly: this.readOnly, folder: FOLDER };
  }

  readonly host: BookHost = {
    cards: {
      library: async (botId) => { this.libraryCalls++; return botId === "main" || botId === BOT ? this.library() : null; },
      shown: async () => this.shownCards,
      states: async (_botId, cards) => cards.map(({ card, command, name, data }): CardState => {
        const detail = this.entries[name]?.detail ?? null;
        const ran = this.lastRuns.get(card);
        const run = ran && command && ran.command === command ? { status: ran.status, data: ran.data, error: null, ranAt: ran.ranAt } : null;
        const approved = !!command && this.approved.has(command) && (detail === null || this.approved.has(`Detail command: ${detail}`));
        const state = !command ? { status: "idle" as const, data: null, error: null, ranAt: null } : !approved ? { status: "approve" as const, data: null, error: null, ranAt: null } : run ?? { status: "idle" as const, data: null, error: null, ranAt: null };
        return {
          folder: FOLDER, detail, every: this.entries[name]?.every ?? null, ...state,
          images: {}, dataImages: data && data.includes("chart.png") ? { "chart.png": "botling-card://image/abc" } : {}, lastRan: this.lastRan.get(card) ?? null, run,
        };
      }),
      run: async (_botId, card, command, force) => {
        if (!this.approved.has(command)) return false;
        this.runs.push({ card, command, force });
        return true;
      },
      ask: async (_botId, _card, command, component) => {
        const detail = this.entries[component]?.detail ?? null;
        return this.approved.has(command) && (detail === null || this.approved.has(`Detail command: ${detail}`)) ? null : { command, folder: FOLDER, detail, card: component };
      },
      setNotes: async (botId, notes) => { this.notes.push({ botId, notes }); },
      legacyPins: async () => this.legacy,
    },
    load: (botId) => (this.stored.get(botId) as unknown[] | undefined) ?? null,
    save: (botId, pins: PinRecord[]) => { this.stored.set(botId, JSON.parse(JSON.stringify(pins))); },
    publish: async (botId, data) => { this.published.push({ botId, data }); },
  };

  book(): PinBook {
    return new PinBook(this.host, () => this.clock);
  }
}

export const basePin = (extra: Record<string, unknown> = {}) => ({ id: "P1", name: "gpu-status", data: "null", refresh: "manual", minutes: 15, size: "4x2", makingLive: false, ...extra });
