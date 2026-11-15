// Linux systemd user unit builder and path for `botlingd service` (M6-08, D74).
import { join } from "node:path";
import type { ServiceSpec } from "./index";

export const SYSTEMD_UNIT_NAME = "botlingd.service";

export function systemdUnitPath(home: string): string {
  return join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

export function quoteSystemdArg(arg: string): string {
  const escapedPercent = arg.replace(/%/g, "%%");
  if (escapedPercent.length > 0 && !/[\s"'\\]/.test(escapedPercent)) return escapedPercent;
  return `"${escapedPercent.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function quoteSystemdEnv(key: string, value: string): string {
  if (/[\r\n=]/.test(key)) throw new Error(`Invalid systemd environment key: ${key}`);
  const escaped = `${key}=${value}`
    .replace(/%/g, "%%")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `Environment="${escaped}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const execStart = [spec.program, ...spec.args].map(quoteSystemdArg).join(" ");
  const envLines = Object.entries(spec.env).map(([key, value]) => quoteSystemdEnv(key, value));

  return [
    "[Unit]",
    "Description=Botling server",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    ...envLines,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
