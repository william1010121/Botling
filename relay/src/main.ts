import { loadConfig } from './config.ts';
import { startRelay } from './server.ts';

const config = loadConfig();
const running = await startRelay(config);
// No room ids, addresses or tokens are logged, ever.
console.log(`botling-relay listening on ${config.host}:${running.port}${config.staticDir ? ' (serving /mobile/)' : ''}`);
const stop = () => { void running.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
