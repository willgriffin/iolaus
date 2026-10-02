import { resolve } from 'node:path';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const appRoot = resolve(import.meta.dirname, '..');

await build({
  configFile: false,
  plugins: [svelte()],
  root: appRoot,
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(
        appRoot,
        'src/lib/components/mcp-apps/IolausOpportunityWorkspace.entry.ts',
      ),
      formats: ['iife'],
      name: 'IolausOpportunityWorkspace',
      fileName: 'iolaus-opportunity-workspace',
    },
    outDir: resolve(
      appRoot,
      'src/lib/components/mcp-apps/generated',
    ),
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
