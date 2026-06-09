import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // cloudflareTest is a Vite plugin that resolves the `cloudflare:test` module
    // and wires up SELF + DO bindings so integration tests run in workerd.
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      main: './src/index.ts',
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
