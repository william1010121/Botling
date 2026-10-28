import { defineConfig } from 'vitest/config';
// Botling Web's renderer build defines __BOTLING_WEB__ (build-renderer.mjs web mode); tests run the same mode.
export default defineConfig({ define: { __BOTLING_WEB__: 'true' }, test: { include: ['mobile/*.test.{ts,tsx}'], maxWorkers: 1, fileParallelism: false } });
