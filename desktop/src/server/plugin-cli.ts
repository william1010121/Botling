// `botlingd plugins` and `botlingd plugins grant <name> --tier read|request|write` (M5-14c), over the running botlingd's
// local socket (pairing/admin-client.ts). The words are the user-approved ones of M5-14b / M5-14d; input and output are
// injected, so tests drive the same code.
//
//   plugins                               one line per plugin: <name>  <tier word>  (code <first 8 of the hash>[, carried
//                                         from <old 8>][; asks more than code <old 8>: <what grew>; allow it again])
//   plugins grant <name> --tier <tier>    grants the tier at the plugin's current code, with what it asks for
import { RowKey } from "../protocol/table-rows";
import type { AdminClient, CliIo } from "./pairing";
import type { GrantTier, PluginGrantAnswer, PluginListRow } from "./plugin-admin";

/** The tier words of M5-14b (`none` is "Not allowed"). */
export const TIER_WORDS: Readonly<Record<GrantTier, string>> = {
  none: "Not allowed",
  read: "Read only",
  request: "Send what it asks for",
  write: "Change its own data on the server",
};

const GRANTABLE = ["read", "request", "write"] as const;
const USAGE = "usage: botlingd plugins [grant <name> --tier read|request|write]";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const codeOf = (hash: string) => hash.slice(0, 8);
/**
 * A word the user typed, as it is echoed: control, line-break and bidi characters become `\uXXXX`, so an argument can
 * never print a second line (a fake "may now" line) or drive the terminal. Ordinary names print byte for byte.
 */
const shown = (word: string) =>
  word.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** `botlingd plugins …`; resolves with the exit code. `args` are the words after `plugins`. */
export async function pluginsCommand(client: AdminClient, io: CliIo, args: string[]): Promise<number> {
  if (args.length === 0) return listPlugins(client, io);
  if (args[0] !== "grant") { io.out(USAGE); return 2; }
  // Exactly one name and one `--tier <tier>`, in either order. Another word (`grant my plugin --tier read`), a second
  // `--tier` or an unknown flag is the usage line, never a grant for the first word alone.
  const rest = args.slice(1);
  const at = rest.indexOf("--tier");
  if (rest.length !== 3 || (at !== 0 && at !== 1)) { io.out(USAGE); return 2; }
  const tier = rest[at + 1]!;
  const name = rest[at === 0 ? 2 : 0]!;
  if (name.startsWith("--")) { io.out(USAGE); return 2; }
  // Checked before the server is asked: the three words the card names (`none` is not a CLI word).
  if (!(GRANTABLE as readonly string[]).includes(tier)) { io.out(`unknown tier "${shown(tier)}" (use read, request or write)`); return 2; }
  // A name no plugin row can have (a control character, a space, over 64 characters) is not on this machine; the
  // server is not asked (it would refuse a name over 200 characters as a malformed request, exit 1).
  if (!RowKey.safeParse(`plugin:${name}`).success) { io.out(`no plugin named "${shown(name)}" on this machine`); return 2; }
  return grantPlugin(client, io, name, tier as (typeof GRANTABLE)[number]);
}

async function listPlugins(client: AdminClient, io: CliIo): Promise<number> {
  try {
    const { plugins } = await client.request({ op: "plugins.list" }) as { plugins: PluginListRow[] };
    for (const plugin of plugins) {
      const carried = plugin.carriedFrom ? `, carried from ${shown(codeOf(plugin.carriedFrom))}` : "";
      const grew = plugin.grewFrom ? `; asks more than code ${shown(codeOf(plugin.grewFrom.codeHash))}: ${shown(plugin.grewFrom.grew.join(", "))}; allow it again` : "";
      io.out(`${shown(plugin.name)}  ${TIER_WORDS[plugin.tier]}  (code ${shown(codeOf(plugin.codeHash))}${carried}${grew})`);
    }
    return 0;
  } catch (error) {
    io.out(`cannot list the plugins: ${shown(errorText(error))}`);
    return 1;
  }
}

async function grantPlugin(client: AdminClient, io: CliIo, name: string, tier: (typeof GRANTABLE)[number]): Promise<number> {
  let answer: PluginGrantAnswer;
  try {
    answer = await client.request({ op: "plugins.grant", plugin: name, tier }) as PluginGrantAnswer;
  } catch (error) {
    io.out(`cannot grant ${name}: ${shown(errorText(error))}`);
    return 1;
  }
  if (answer.ok) { io.out(`${answer.name} may now: ${TIER_WORDS[answer.tier]} (code ${codeOf(answer.codeHash)}).`); return 0; }
  if (answer.reason === "no-plugin") { io.out(`no plugin named "${name}" on this machine`); return 2; }
  io.out(`not granted: ${shown(answer.detail)}`);
  return 1;
}
