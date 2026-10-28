import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['mobile/*.test.{ts,tsx}'], maxWorkers: 1, fileParallelism: false } });
