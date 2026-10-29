import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/provider-validation/agy-delegation.test.ts'],maxWorkers:1,pool:'forks',testTimeout:290_000,hookTimeout:10_000}});
