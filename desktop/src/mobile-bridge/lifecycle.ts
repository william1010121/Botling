import type { Server } from 'node:https';

// Seven retries, at most 15.75 seconds of waiting; only port handover is retryable.
const delays = [250, 500, 1000, 2000, 4000, 4000, 4000];
export function listenWithHandover(server: Server, port: number, host: string, failed: (error: Error) => void) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0, stopped = false, listening = false;
  const close = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    abort.abort(); // Also cancels a listen that has not emitted 'listening' yet.
    server.close();
    server.closeAllConnections();
  };
  const fail = (error: NodeJS.ErrnoException) => {
    if (stopped) return;
    if (!listening && error.code === 'EADDRINUSE' && retries < delays.length) {
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; listen(); }, delays[retries++]);
      timer.unref();
      return;
    }
    close();
    failed(error);
  };
  const listen = () => {
    if (stopped) return;
    try { server.listen({ port, host, signal: abort.signal }); }
    catch (error) { fail(error as NodeJS.ErrnoException); }
  };
  server.on('error', fail);
  server.on('listening', () => {
    if (stopped) { server.close(); return; }
    listening = true;
  });
  listen();
  return { close };
}

/** Stop accepting mobile work before core teardown begins, including stdin EOF. */
export function closeWithCore(core: { shutdown(): Promise<void> }, mobile: { close(): void }) {
  const shutdown = core.shutdown.bind(core);
  core.shutdown = () => { mobile.close(); return shutdown(); };
}
