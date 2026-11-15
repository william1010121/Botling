// The page's CSP has `script-src 'self'` with no `unsafe-eval`. zod 4 probes once whether `new Function` works (to
// compile fast object parsers); under this CSP the probe throws, zod falls back, and the browser still reports a
// `script-src eval` violation for it. Telling zod up front that eval is off skips the probe: same parsing, no report.
// Imported first by main.tsx so it runs before any schema is used.
import { z } from "zod";

z.config({ jitless: true });
