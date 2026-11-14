// The command hash a receipt stores (protocol v1 §11.1): SHA-256 over the canonical JSON of `cmd`, `scope` and
// `basis`. `floor` and `inc` are left out on purpose: a re-send after a rewind or a restore carries other values of
// both and is still the same command.
import { createHash } from "node:crypto";
import type { Command } from "../../contract";
import { canonicalJson, type Cursor, type Scope } from "../../protocol";

export function cmdHash(input: { cmd: Command; scope: Scope; basis?: Cursor }): string {
  return createHash("sha256").update(canonicalJson({ cmd: input.cmd, scope: input.scope, basis: input.basis })).digest("hex");
}
