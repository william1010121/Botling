// Shared by the main-process loader and plain Node developer commands. Configuration lives in
// the stable dev-trial profile, never inside the installed app or a disposable source checkout.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
export function rendererAppData(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(home, ".config");
}
export function rendererConfigPath(appData) {
  return join(appData, "Botling 2 Dev Trial", "renderer-development.json");
}
export function validateRendererDirectory(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new Error("Renderer directory must be an absolute renderer build directory");
  for (const name of ["index.html", "renderer.js", "styles.css", "chat.html", "chat.js", "chat.css", "frame.css"]) {
    try { if (statSync(join(directory, name)).isFile()) continue; } catch { /* report the build action */ }
    throw new Error(`Missing renderer asset ${name}; run npm run renderer:build first`);
  }
  return resolve(directory);
}
export function readRendererConfiguration(appData) {
  const path = rendererConfigPath(appData);
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    if (!config || config.version !== 1 || typeof config.enabled !== "boolean")
      throw new Error("Expected renderer configuration version 1 and an explicit enabled boolean");
    if (!config.enabled) return { path };
    return { path, directory: validateRendererDirectory(config.directory) };
  } catch (error) {
    if (error.code === "ENOENT" && error.path === path) return { path };
    return { path, warning: `Ignoring renderer configuration ${path}: ${error.message}; using bundled renderer` };
  }
}
export function writeRendererConfiguration(appData, directory) {
  // Validate first: a mistaken enable command must not overwrite a working opt-in.
  const config = directory === null ? { version: 1, enabled: false }
    : { version: 1, enabled: true, directory: validateRendererDirectory(directory) };
  const path = rendererConfigPath(appData), temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(join(appData, "Botling 2 Dev Trial"), { recursive: true });
  try { writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
  return path;
}
