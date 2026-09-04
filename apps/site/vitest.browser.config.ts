import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';
import baseConfig from './vite.config.js';

/**
 * The application suite is SSR-oriented. This isolated browser configuration
 * exercises client-only Svelte lifecycle behavior without changing that
 * server-test contract.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      conditions: ['browser'],
    },
    test: {
      environment: 'happy-dom',
      include: [
        'src/lib/components/sources/SourceCrawlProgress.browser.spec.ts',
      ],
    },
  }),
);
