import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Loaded the same way next dev/build pick up .env.local — vitest does not do
// this on its own. Without it, test/queries.integration.test.ts would never
// see DATABASE_URL and would silently skip forever, even with real
// credentials sitting in .env.local. process.loadEnvFile is Node >= 20.6;
// wrapped because CI (or a fresh clone with only real env vars exported)
// has no .env.local file at all, and that absence is not an error here.
try {
  process.loadEnvFile(path.resolve(__dirname, '.env.local'));
} catch {
  // No .env.local — fine, whatever is already in process.env stands.
}

export default defineConfig({
  test: {
    environment: 'node',
  },
  resolve: {
    alias: {
      // See test/stubs/server-only.js — mirrors Next's own bundler aliasing.
      'server-only': path.resolve(__dirname, 'test/stubs/server-only.js'),
      '@': path.resolve(__dirname),
    },
  },
});
