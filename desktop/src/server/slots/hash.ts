// The command hash a receipt stores (protocol v1 §11.1): SHA-256 over the canonical JSON of `cmd`, `scope` and
// `basis`, and `via` (plan change N1) only when the command carries one: canonical JSON leaves an absent member out, so
// every hash of a command without `via` (and every receipt stored before N1) is unchanged. `floor` and `inc` are left out on purpose: a re-send after a rewind or a restore carries other values of
// both and is still the same command.
import { createHash } from "node:crypto";
import type { Command } from "../../contract";
import { canonicalJson, type Cursor, type Scope, type Via } from "../../protocol";

export function cmdHash(input: { cmd: Command; scope: Scope; basis?: Cursor; via?: Via }): string {
  return createHash("sha256").update(canonicalJson({ cmd: input.cmd, scope: input.scope, basis: input.basis, via: input.via })).digest("hex");
}
