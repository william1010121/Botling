// `check-plugin <plugin folder>`: the checks 2.0 runs before loading a plugin (1.x: the Botling
// binary's --check-plugin), for Maintainer's release steps. Prints the problems; exits 1 if any.
import { join } from "node:path";
import { checkReport } from "./check-report";

// Bundled to <out>/host/check-plugin.cjs: the built-ins are <out>/builtin-plugins unless the core names them (core-process.ts).
const report = checkReport(process.argv[2], "incoming", process.env.BOTLING_BUILTIN_PLUGINS || join(__dirname, "..", "builtin-plugins"));
process.stdout.write(report.stdout);
process.stderr.write(report.stderr);
process.exitCode = report.code;
