#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { build } from 'esbuild';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const candidate = process.env.IOLAUS_DESKTOP_FRAMEWORK;
if (candidate && !candidate.startsWith('/'))
  throw new Error(
    'IOLAUS_DESKTOP_FRAMEWORK must be an absolute package directory.',
  );
const { createBundlePlan, createBundleSeams, runBundle } = await import(
  candidate
    ? pathToFileURL(join(candidate, 'dist/bundler.js')).href
    : '@happyvertical/smrt-desktop/bundler'
);
const { createBuildPlan, createBuildSeams, runBuild } = await import(
  candidate
    ? pathToFileURL(join(candidate, 'dist/builder.js')).href
    : '@happyvertical/smrt-desktop/builder'
);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = resolve(
  process.env.IOLAUS_DESKTOP_OUTPUT || join(root, '.desktop'),
);
const stage = join(work, 'stage');
const bundle = join(work, 'bundle');
const installers = join(work, 'installers');
const command = process.argv[2];
function run(args, cwd = root) {
  const result = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0)
    throw new Error(`pnpm ${args[0]} failed (${result.status}).`);
}
function copy(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
}
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  });
}
async function prepare() {
  if (
    Number(process.versions.node.split('.')[0]) !== 26 ||
    Number(process.versions.node.split('.')[1]) < 10
  ) {
    throw new Error('Desktop builds require Node 26.10+ (see package.json).');
  }
  const reuseBuild = process.argv.includes('--use-existing-build');
  const siteRevision = process.env.IOLAUS_DESKTOP_BUILD_REVISION;
  if (reuseBuild && !/^[a-f0-9]{40}$/.test(siteRevision || '')) {
    throw new Error(
      '--use-existing-build requires IOLAUS_DESKTOP_BUILD_REVISION with the full 40-character hexadecimal compiled-site commit.',
    );
  }
  if (!reuseBuild) run(['--filter', '@willgriffin/iolaus-site', 'build']);
  if (!existsSync(join(root, 'apps/site/build/index.js')))
    throw new Error('Production site build is missing.');
  mkdirSync(work, { recursive: true });
  writeFileSync(
    join(work, 'build-inputs.json'),
    `${JSON.stringify(
      {
        reusedExistingBuild: reuseBuild,
        siteRevision: siteRevision || null,
        buildEntrySha256: createHash('sha256')
          .update(readFileSync(join(root, 'apps/site/build/index.js')))
          .digest('hex'),
      },
      null,
      2,
    )}\n`,
  );
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const site = JSON.parse(
    readFileSync(join(root, 'apps/site/package.json'), 'utf8'),
  );
  const dependencies = { ...site.dependencies };
  // The workspace resume package is compiled into the Vite server output.
  delete dependencies['@willgriffin/iolaus-resume'];
  // Freeze catalog references to the installed versions used by this site build.
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (specifier.startsWith('catalog:')) {
      dependencies[name] = JSON.parse(
        readFileSync(
          join(root, 'apps/site/node_modules', name, 'package.json'),
          'utf8',
        ),
      ).version;
    }
  }
  writeFileSync(
    join(stage, 'package.json'),
    `${JSON.stringify({ name: 'iolaus', version: '0.1.0', type: 'module', private: true, dependencies }, null, 2)}\n`,
  );
  copy(join(root, 'apps/site/build'), join(stage, 'build'));
  for (const path of [
    'apps/site/smrt.config.js',
    'apps/site/scripts/postgres-permissions-config.js',
    'desktop/icon.png',
    'desktop/entry.mjs',
  ])
    copy(join(root, path), join(stage, path));
  copy(
    join(root, 'apps/site/.smrt/manifest.json'),
    join(stage, 'apps/site/manifest.json'),
  );
  mkdirSync(join(stage, 'apps/site'), { recursive: true });
  writeFileSync(
    join(stage, 'apps/site/package.json'),
    `${JSON.stringify({ name: site.name, type: 'module' })}\n`,
  );
  const setupBuild = await build({
    entryPoints: [join(root, 'desktop/setup.ts')],
    outfile: join(stage, 'desktop/setup.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfig: join(root, 'apps/site/tsconfig.runtime.json'),
    metafile: true,
  });
  writeFileSync(
    join(work, 'desktop-setup.metafile.json'),
    `${JSON.stringify(setupBuild.metafile, null, 2)}\n`,
  );
  // Configuration and bundled server code share these public runtime modules.
  for (const path of readdirSync(join(root, 'scripts')).filter(
    (name) =>
      name.startsWith('smrt-') &&
      name.endsWith('.mjs') &&
      !name.endsWith('.test.mjs') &&
      ![
        'smrt-app.mjs',
        'smrt-portability.mjs',
        'smrt-portability-assets.mjs',
        'smrt-worker.mjs',
      ].includes(name),
  ))
    copy(join(root, 'scripts', path), join(stage, 'scripts', path));
  const config = JSON.parse(
    readFileSync(join(root, 'desktop/smrt-desktop.json'), 'utf8'),
  );
  config.runtimeFiles = [
    ...files(join(stage, 'apps'), 'apps'),
    ...files(join(stage, 'scripts'), 'scripts'),
    'desktop/entry.mjs',
    'desktop/setup.mjs',
  ];
  writeFileSync(
    join(stage, 'smrt-desktop.json'),
    `${JSON.stringify(config, null, 2)}\n`,
  );
  copy(join(root, '.npmrc'), join(stage, '.npmrc'));
  // A standalone frozen lock avoids workspace links and ancestor configuration.
  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const overrides = workspace.slice(
    workspace.indexOf('overrides:'),
    workspace.indexOf('# pnpm 11 reads'),
  );
  writeFileSync(
    join(stage, 'pnpm-workspace.yaml'),
    `packages: []\n${overrides}`,
  );
  run(['install', '--lockfile-only', '--ignore-scripts'], stage);
}
if (command === 'bundle') {
  if (!process.argv.includes('--reuse-stage')) await prepare();
  const bridgeFile = join(work, 'smrt-mcp-bridge.mjs');
  await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          './bin/smrt-mcp-bridge.js',
          import.meta.resolve('@happyvertical/smrt-app-cli'),
        ),
      ),
    ],
    outfile: bridgeFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
  });
  const frameworkPath =
    candidate ||
    dirname(
      fileURLToPath(
        import.meta.resolve('@happyvertical/smrt-desktop/package.json'),
      ),
    );
  const framework = JSON.parse(
    readFileSync(join(frameworkPath, 'package.json'), 'utf8'),
  );
  writeFileSync(
    join(work, 'framework-provenance.json'),
    `${JSON.stringify({ name: framework.name, version: framework.version, localReleaseCandidate: Boolean(candidate), nodeVersion: '26.12.1', requireVerifiedPins: true }, null, 2)}\n`,
  );
  const plan = await createBundlePlan({
    appDir: stage,
    outDir: bundle,
    force: true,
    bridgeFile,
    nodeVersion: '26.12.1',
    requireVerifiedPins: true,
  });
  console.log(
    JSON.stringify(
      await runBundle(
        plan,
        await createBundleSeams({
          onStage: (value) => console.log(`bundle: ${value}`),
        }),
      ),
      null,
      2,
    ),
  );
} else if (command === 'build') {
  const plan = createBuildPlan(
    {
      appDir: stage,
      bundleDir: bundle,
      outDir: installers,
      smoke: process.argv.includes('--smoke'),
    },
    { platform: process.platform, arch: process.arch, cwd: root },
  );
  console.log(
    JSON.stringify(
      await runBuild(
        plan,
        await createBuildSeams({
          onStage: (value) => console.log(`build: ${value}`),
        }),
      ),
      null,
      2,
    ),
  );
} else if (command === 'install') {
  if (process.platform !== 'darwin')
    throw new Error('This installation command supports macOS.');
  const source = join(installers, 'Iolaus.app');
  if (!existsSync(source))
    throw new Error('Run desktop:bundle and desktop:build first.');
  const destination = join(homedir(), 'Applications', 'Iolaus.app');
  if (existsSync(destination))
    throw new Error(
      'Iolaus.app already exists; quit it and move it aside before reinstalling.',
    );
  copy(source, destination);
  console.log(`Installed ${destination}\nLaunch: open "${destination}"`);
} else {
  throw new Error(
    'Usage: desktop.mjs bundle [--use-existing-build]|build [--smoke]|install',
  );
}
