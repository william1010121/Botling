// The PDF text job's child process (M2 step 15; built to out/server/pdf-text.cjs): `pdf-text.cjs <pdf> <out.json>`.
// Runs under Node, or Electron as Node (ELECTRON_RUN_AS_NODE), started by media/jobs.ts through run.ts (nice, a time
// limit, the pid file). Writes the JSON to `<out.json>` and exits 0; any failure exits 1 with the reason on stderr.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { cmapsDir, extractPdfText } from "./pdf-extract";
import { PDF_TEXT_MAX_BYTES } from "./pdf-text";

async function main(): Promise<void> {
  const [file, out] = process.argv.slice(2);
  if (!file || !out) throw new Error("usage: pdf-text <pdf> <out.json>");
  if (statSync(file).size > PDF_TEXT_MAX_BYTES) throw new Error(`the PDF is above ${PDF_TEXT_MAX_BYTES} bytes`);
  const cMapUrl = cmapsDir();
  const text = await extractPdfText(new Uint8Array(readFileSync(file)), cMapUrl ? { cMapUrl } : {});
  writeFileSync(out, JSON.stringify(text));
}

main().then(() => process.exit(0), (error: unknown) => {
  process.stderr.write(`pdf-text: ${String((error as Error)?.message ?? error)}\n`);
  process.exit(1);
});
