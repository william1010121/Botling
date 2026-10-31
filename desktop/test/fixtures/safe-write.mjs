// Shared by the fake CLIs: they never write outside the test areas (FAKE_ROOT if set; otherwise the OS
// temp dir and desktop/.cache/test-data, where tempDir() puts test data). A test that points a bot at a
// real project (the repo, the home folder) must fail loudly, not overwrite its files.
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const testData = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".cache", "test-data");
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

export function safeWritePath(file, cwd = process.cwd(), env = process.env) {
  const path = resolve(cwd, file);
  const roots = (env.FAKE_ROOT ? [env.FAKE_ROOT] : [tmpdir(), testData]).map(real);
  const dir = dirname(path);
  const actual = join(existsSync(dir) ? realpathSync(dir) : dir, basename(path));
  if (!roots.some((root) => actual === root || actual.startsWith(root + sep))) throw new Error(`fake CLI refuses to write outside ${roots.join(" or ")}: ${path} (cwd ${cwd})`);
  return path;
}
