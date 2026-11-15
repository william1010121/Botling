// macOS LaunchAgent plist builder and path for `botlingd service` (M6-08, D74).
import { join } from "node:path";
import type { ServiceSpec } from "./index";

export const DEFAULT_APP_ID = "dev.botling.v3";
export const DEFAULT_SERVICE_LABEL = `${DEFAULT_APP_ID}.botlingd`;

export function serviceLabel(appId = DEFAULT_APP_ID): string {
  return `${appId}.botlingd`;
}

export function launchAgentPath(home: string, label = DEFAULT_SERVICE_LABEL): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function launchAgentPlist(spec: ServiceSpec): string {
  const programArgs = [spec.program, ...spec.args]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.env)
    .map(([key, value]) => `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`)
    .join("\n");
  const logPath = escapeXml(join(spec.dataDir, "botlingd.service.log"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArgs,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...(envEntries ? [envEntries] : []),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${logPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${logPath}</string>`,
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
