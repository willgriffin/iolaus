import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

/**
 * The application suite is SSR-oriented. This isolated browser configuration
 * exercises client-only Svelte lifecycle behavior without changing that
 * server-test contract.
 */
export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/lib/components/sources/SourceCrawlProgress.browser.spec.ts'],
  },
});
