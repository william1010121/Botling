// M7-O04: the pin of the built-in orchestration plugin. This is the sha256 of builtin-plugins/botling.orchestration/rules.json as it
// ships. Core uses that file's rules only when the bytes it read hash to this; any other file (a bot's edit, a changed install) is
// refused and core uses its own rules (plugin-rules.ts). Changing rules.json on purpose means changing this line in the same commit:
// test/unit/orchestration-plugin.test.ts fails until it matches.
export const BUILTIN_RULES_SHA256 = "7ad573d96c472a194de4828f724c16868164635de9898f6d66e58f8bf3e6aa11";
