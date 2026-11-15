// `botlingd plugins` and `botlingd plugins grant <name> --tier read|request|write` (M5-14c), over the running botlingd's
// local socket (pairing/admin-client.ts). The words are the user-approved ones of M5-14b / M5-14d; input and output are
// injected, so tests drive the same code.
//
//   plugins                               one line per plugin: <name>  <tier word>  (code <first 8 of the hash>)
//   plugins grant <name> --tier <tier>    grants the tier at the plugin's current code, with what it asks for
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

/** `botlingd plugins …`; resolves with the exit code. `args` are the words after `plugins`. */
export async function pluginsCommand(client: AdminClient, io: CliIo, args: string[]): Promise<number> {
  if (args.length === 0) return listPlugins(client, io);
  if (args[0] !== "grant") { io.out(USAGE); return 2; }
  const rest = args.slice(1);
  const at = rest.indexOf("--tier");
  const tier = at >= 0 ? rest[at + 1] : undefined;
  const name = rest.find((word, index) => !word.startsWith("--") && index !== at + 1);
  if (name === undefined || tier === undefined) { io.out(USAGE); return 2; }
  // Checked before the server is asked: the three words the card names (`none` is not a CLI word).
  if (!(GRANTABLE as readonly string[]).includes(tier)) { io.out(`unknown tier "${tier}" (use read, request or write)`); return 2; }
  return grantPlugin(client, io, name, tier as (typeof GRANTABLE)[number]);
}

async function listPlugins(client: AdminClient, io: CliIo): Promise<number> {
  try {
    const { plugins } = await client.request({ op: "plugins.list" }) as { plugins: PluginListRow[] };
    for (const plugin of plugins) io.out(`${plugin.name}  ${TIER_WORDS[plugin.tier]}  (code ${codeOf(plugin.codeHash)})`);
    return 0;
  } catch (error) {
    io.out(`cannot list the plugins: ${errorText(error)}`);
    return 1;
  }
}

async function grantPlugin(client: AdminClient, io: CliIo, name: string, tier: (typeof GRANTABLE)[number]): Promise<number> {
  let answer: PluginGrantAnswer;
  try {
    answer = await client.request({ op: "plugins.grant", plugin: name, tier }) as PluginGrantAnswer;
  } catch (error) {
    io.out(`cannot grant ${name}: ${errorText(error)}`);
    return 1;
  }
  if (answer.ok) { io.out(`${answer.name} may now: ${TIER_WORDS[answer.tier]} (code ${codeOf(answer.codeHash)}).`); return 0; }
  if (answer.reason === "no-plugin") { io.out(`no plugin named "${name}" on this machine`); return 2; }
  io.out(`not granted: ${answer.detail}`);
  return 1;
}
