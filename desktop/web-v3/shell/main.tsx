// Botling 3's phone/browser page: the shell (pairing, connection banner, This device) with the 2.x renderer mounted
// through bridge-v3.ts. Built by web-v3/build.mjs into web-v3/dist, served by botlingd at /v3/.
import "./no-eval";
import { createRoot } from "react-dom/client";
import { Shell } from "./Shell";
createRoot(document.getElementById("root")!).render(<Shell />);
