// `botlingd fetch grants` and `botlingd fetch revoke <n>` (§16, M5-06c): the "always" fetch grants of this server, over
// the local admin socket. `<n>` is the position in the `grants` list (oldest first), so a revoke names what the user saw.
import { homedir } from "node:os";
import type { FetchGrantRow } from "./approval";
import { oneLine, tildePath } from "./approval";

export interface FetchCliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface FetchAdmin {
  request(op: { op: "fetch.grants" } | { op: "fetch.revoke"; grantId: string }): Promise<unknown>;
}

const day = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** `<bot> on <machine> may read <~path>` (names and paths are a peer's words: one line, no control characters). */
const mayRead = (row: FetchGrantRow, home: string, verb: string): string =>
  `${oneLine(row.botName, 100)} on ${oneLine(row.machine, 100)} ${verb} ${oneLine(tildePath(row.prefix, home))}`;

/** The exit code: 0, 2 for a wrong command or number. */
export async function fetchCommand(admin: FetchAdmin, io: FetchCliIo, args: string[], home = homedir()): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "grants" && sub !== "revoke") {
    io.err("fetch needs a subcommand: botlingd fetch grants | botlingd fetch revoke <n>");
    return 2;
  }
  const { rows } = await admin.request({ op: "fetch.grants" }) as { rows: FetchGrantRow[] };
  if (sub === "grants") {
    if (!rows.length) { io.out("No fetch grants."); return 0; }
    rows.forEach((row, index) => io.out(`${index + 1}. ${mayRead(row, home, "may read")} (always, since ${day(row.createdAt)})`));
    return 0;
  }
  const typed = rest[0] ?? "";
  const row = /^[1-9]\d{0,8}$/.test(typed) ? rows[Number(typed) - 1] : undefined;
  const refuse = () => { io.err(`no grant ${oneLine(typed, 40)} (botlingd fetch grants lists them)`); return 2; };
  if (!row) return refuse();
  const { revoked } = await admin.request({ op: "fetch.revoke", grantId: row.grantId }) as { revoked: boolean };
  if (!revoked) return refuse();
  io.out(`Revoked: ${mayRead(row, home, "may no longer read")}.`);
  return 0;
}
