// The renderer's plugin kernel (kernel step 1 step 7; Web/src/plugin-kernel): what the app page's own surfaces provide to
// plugin frames as services. The chat surface (`:chat`, a name no plugin can have) provides `composer.insertQuote` while
// App is up (composer-quote.ts); a frame's call reaches it through the frame broker (plugin-frame-host.ts) as a kernel
// call carrying the frame's plugin. The Note declares that it uses it (soft: with no provider the quote is not inserted).
import { Kernel } from "../../../Web/src/plugin-kernel";

/** The chat surface's instance in the renderer's kernel. */
export const CHAT_SURFACE = ":chat";
/** The service a plugin frame's `ccb.composer.insertQuote` calls. */
export const INSERT_QUOTE = "composer.insertQuote";

export const rendererKernel = new Kernel();
rendererKernel.install({ name: CHAT_SURFACE, provides: { services: [INSERT_QUOTE] } });
