// Stage node-pty beside main.cjs. Keep native paths intact and restore npm's missing
// spawn-helper executable bit in our own output, never in the shared dependency cache.
import { cpSync, existsSync, mkdirSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
export function stageTerminalRuntime(root, mainDirectory) {
  const source = join(root, 'node_modules/node-pty');
  const target = join(mainDirectory, 'node_modules/node-pty');
  rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
  for (const name of ['package.json', 'LICENSE', 'lib', 'prebuilds', 'build/Release']) {
    if (existsSync(join(source, name))) cpSync(join(source, name), join(target, name), { recursive: true });
  }
  function helpers(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) helpers(file);
      else if (entry.name === 'spawn-helper') chmodSync(file, 0o755);
    }
  }
  helpers(target);
}
