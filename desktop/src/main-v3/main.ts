// Botling 3's Electron main (M1 step 11): the 2.x main, unchanged, with its core client swapped for the server client
// (build.mjs `buildMainV3` resolves src/main/main.ts's `./core-client` to ./server-client). The guard runs first.
import "./guard";
import "../main/main";
