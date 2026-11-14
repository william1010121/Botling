// Botling 3's Electron main (M1 step 11): the 2.x main, unchanged, with its core client swapped for the server client
// (build.mjs `buildMainV3` resolves src/main/main.ts's `./core-client` to ./server-client). The guard runs first; the
// content path (step 13) wraps main's protocol calls before main makes them.
import "./guard";
import "./content-install";
import "../main/main";
