import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/mobile-bridge/*.test.ts'], maxWorkers: 1, fileParallelism: false } });
