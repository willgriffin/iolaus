import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { buildDomainKnowledgeManifest } from '@happyvertical/smrt-core/knowledge';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { assertLocalLoopbackHost } from './src/lib/server/runtime-host.js';

function syncProjectSmrtKnowledge(): void {
  const siteRoot = process.cwd();
  const repoRoot = resolve(siteRoot, '../..');
  const siteManifestPath = resolve(siteRoot, '.smrt/manifest.json');
  const siteRegisterPath = resolve(siteRoot, '.smrt/register.js');
  const repoManifestPath = resolve(repoRoot, '.smrt/manifest.json');
  const repoKnowledgePath = resolve(repoRoot, '.smrt/smrt-knowledge.json');
  const repoRegisterPath = resolve(repoRoot, '.smrt/register.js');
  if (!existsSync(siteManifestPath)) {
    return;
  }
  const manifest = JSON.parse(readFileSync(siteManifestPath, 'utf8'));

  mkdirSync(dirname(repoManifestPath), { recursive: true });
  writeFileSync(repoManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  if (existsSync(siteRegisterPath)) {
    writeFileSync(
      repoRegisterPath,
      "import '../apps/site/.smrt/register.js';\n",
      'utf8',
    );
  }
  writeFileSync(
    repoKnowledgePath,
    JSON.stringify(
      buildDomainKnowledgeManifest({
        manifest,
        rootDir: repoRoot,
        manifestPath: repoManifestPath,
        config: {
          includeDocs: true,
          includePrompts: true,
          summary: 'Iolaus SvelteKit site domain model.',
        },
      }),
      null,
      2,
    ),
    'utf8',
  );
}

function projectSmrtKnowledgePlugin(): Plugin {
  const sync = () => {
    try {
      syncProjectSmrtKnowledge();
    } catch (error) {
      console.warn('[smrt] Unable to sync project knowledge artifact:', error);
    }
  };

  return {
    name: 'iolaus-project-smrt-knowledge',
    enforce: 'post',
    configResolved(config) {
      if ((process.env.SMRT_RUNTIME_PROFILE || 'local') === 'local') {
        assertLocalLoopbackHost(config.server.host);
        assertLocalLoopbackHost(config.preview.host ?? config.server.host);
      }
    },
    buildStart: sync,
    closeBundle: sync,
    configureServer(server) {
      sync();
      server.watcher.on('change', (path) => {
        const normalizedPath = path.replaceAll('\\', '/');
        if (
          normalizedPath.includes('/src/lib/objects/') ||
          normalizedPath.endsWith('/AGENTS.md') ||
          normalizedPath.endsWith('/package.json')
        ) {
          setTimeout(sync, 0);
        }
      });
    },
  };
}

export default defineConfig({
  test: {
    // Browser lifecycle specs run through `vitest.browser.config.ts`, which
    // selects Svelte's browser export without changing the SSR test suite.
    exclude: ['src/**/*.browser.spec.ts'],
  },
  server: {
    host: '127.0.0.1',
    port: 5723,
    strictPort: true,
  },
  plugins: [
    sveltekit(),
    smrtConsumer({
      projectRoot: process.cwd(),
      svelteKit: true,
    }),
    smrtPlugin({
      include: ['src/lib/objects/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      generateTypes: true,
      svelteKit: {
        enabled: false,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    }),
    projectSmrtKnowledgePlugin(),
  ],
  // Vite 8 transforms with oxc (esbuild.tsconfigRaw is ignored), so legacy
  // decorator support for SMRT objects must be enabled here.
  oxc: {
    decorator: {
      legacy: true,
    },
  },
  build: {
    rollupOptions: {
      external: ['typescript'],
    },
  },
  ssr: {
    external: [
      'typescript',
      // Ships native binaries (@napi-rs/canvas) and lazy-loads puppeteer-core;
      // must stay a runtime require, not be bundled into server chunks.
      '@happyvertical/pdf',
      // Keep the agents package unbundled: when it is inlined into the server
      // build, its @smrt() decorators infer the package name from the bundle
      // path and register AgentConfig as `@willgriffin/iolaus-site:AgentConfig`
      // alongside the manifest's `@happyvertical/smrt-agents:AgentConfig`,
      // which makes `GET /api/_resources` fail with resource-slug-collision.
      '@happyvertical/smrt-agents',
      '@happyvertical/smrt-core',
      '@happyvertical/smrt-profiles',
      '@happyvertical/smrt-users',
      '@happyvertical/smrt-users/sveltekit',
    ],
  },
});
