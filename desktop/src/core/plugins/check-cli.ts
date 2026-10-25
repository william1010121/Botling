// `check-plugin <plugin folder>`: the checks 2.0 runs before loading a plugin (1.x: the Botling
// binary's --check-plugin), for Maintainer's release steps. Prints the problems; exits 1 if any.
import { checkReport } from "./check-report";

const report = checkReport(process.argv[2]);
process.stdout.write(report.stdout);
process.stderr.write(report.stderr);
process.exitCode = report.code;
