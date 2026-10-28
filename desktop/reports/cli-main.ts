// Entry of out/report/report.cjs (build.mjs): `node report.cjs …` runs the report command;
// the app's `--render-report` requires it and calls runCli itself.
import { runCli } from './cli';
export { runCli, USAGE } from './cli';

declare const require: { main?: unknown } | undefined;
declare const module: unknown;
if (typeof require !== 'undefined' && require.main === module) process.exitCode = runCli(process.argv.slice(2));
