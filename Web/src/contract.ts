/**
 * The limits and tables the page shares with Swift. Swift is their source: `WebContract.swift`
 * writes `contract.json` (and its test fails when the file is out of date), so nothing here is
 * typed in twice.
 */
import contract from "./contract.json";

export interface Contract {
  board: { maxColumns: number; maxRows: number; sizeNames: Record<string, string> };
  floating: { widths: [number, number]; heights: [number, number]; max: number };
  panelHeights: [number, number];
  refresh: { minSeconds: number; maxSeconds: number; defaultMinutes: number };
  saveLimit: number;
  imageExtensions: string[];
  componentMention: { startsAfter: string; nameCharacters: string };
}

export const shared = contract as unknown as Contract;

/** `text` with every character a regular expression gives a meaning to escaped. */
export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
}
