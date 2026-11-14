// Wires the content path into the 2.x main without changing it (M1 step 13). Imported by src/main-v3/main.ts after the
// guard and before the 2.x main module, so it runs before main registers its schemes and handlers
// (content-protocol.ts `installContentProtocol` says what it wraps).
import { app, protocol, session } from "electron";
import { activeServerClient } from "./server-client";
import { ContentProtocol, installContentProtocol, PANE_PARTITION, type ProtocolLike } from "./content-protocol";

installContentProtocol({
  protocol: protocol as unknown as ProtocolLike,
  whenReady: () => app.whenReady(),
  paneProtocol: () => session.fromPartition(PANE_PARTITION).protocol as unknown as ProtocolLike,
  content: new ContentProtocol({ link: () => activeServerClient(), audit: (text) => { if (process.env.BOTLING_QUIET !== "1") console.warn(`[content] ${text}`); } }),
});
