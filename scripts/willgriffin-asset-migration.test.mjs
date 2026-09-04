import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  PUBLISHED_RESUME_ALIAS_PATH,
  LocalSourceAssets,
  LocalTargetAssets,
  buildAssetMigrationManifest,
  discoverReferencedAssets,
  importAssetMigrationManifest,
  planPredecessorAssetMigration,
  readAssetMigrationManifest,
  validateAssetMigrationManifest,
  writeAssetMigrationManifest,
} from './willgriffin-asset-migration.mjs';
import {
  buildMigrationBundle,
  loadSupportedMigrationContracts,
} from './willgriffin-migration.mjs';

class MemoryAssets {
  constructor(entries = {}) {
    this.entries = new Map(
      Object.entries(entries).map(([path, value]) => [path, Buffer.from(value)]),
    );
    this.writes = [];
  }

  async exists(path) {
    return this.entries.has(path);
  }

  async read(path) {
    if (!this.entries.has(path)) throw new Error('missing');
    return Buffer.from(this.entries.get(path));
  }

  async write(path, value) {
    this.writes.push(path);
    this.entries.set(path, Buffer.from(value));
  }
}

class MetadataStore {
  constructor(options = {}) {
    this.options = options;
    this.referenceCalls = 0;
    this.aliasCalls = 0;
  }

  async verifyReferences(references) {
    this.referenceCalls += 1;
    if (this.options.rejectReferences) throw new Error('metadata mismatch');
    assert.ok(references.every((reference) => reference.logicalPath));
  }

  async verifyPublishedAlias(alias) {
    this.aliasCalls += 1;
    if (this.options.rejectAlias && alias) throw new Error('alias mismatch');
  }
}

function bundle(overrides = {}) {
  return {
    sourceFingerprint: 'a'.repeat(64),
    runId: `wgd-${'b'.repeat(64)}`,
    tables: [
      {
        name: 'resume_assets',
        rows: [
          {
            sourceId: 'resume-global',
            values: {
              id: 'resume-global',
              application_id: '',
              is_published: true,
              markdown_path: 'generated/resume-global.md',
              text_path: 'generated/resume-global.txt',
              html_path: 'generated/resume-global.html',
              pdf_path: 'generated/resume-global.pdf',
            },
          },
          {
            sourceId: 'application-packet',
            values: {
              id: 'application-packet',
              application_id: 'application-1',
              is_published: false,
              markdown_path: 'applications/application-1/packet.md',
              text_path: '',
              html_path: '',
              pdf_path: 'applications/application-1/packet.pdf',
            },
          },
        ],
      },
      {
        name: 'resume_variants',
        rows: [
          {
            sourceId: 'variant-1',
            values: {
              id: 'variant-1',
              markdown_path: '',
              text_path: '',
              html_path: '',
              pdf_path: 'variants/variant-1.pdf',
            },
          },
        ],
      },
      {
        name: 'attachments',
        rows: [
          {
            sourceId: 'attachment-1',
            values: { id: 'attachment-1', file_path: 'attachments/portfolio.pdf' },
          },
        ],
      },
      ...(overrides.tables || []),
    ],
    ...overrides,
  };
}

function sourceFiles(overrides = {}) {
  return new MemoryAssets({
    'generated/resume-global.md': '# resume',
    'generated/resume-global.txt': 'resume text',
    'generated/resume-global.html': '<p>resume</p>',
    'generated/resume-global.pdf': '%PDF-global',
    'applications/application-1/packet.md': '# packet',
    'applications/application-1/packet.pdf': '%PDF-packet',
    'variants/variant-1.pdf': '%PDF-variant',
    'attachments/portfolio.pdf': '%PDF-attachment',
    ...overrides,
  });
}

test('asset planning loads the released logical contract before validation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'iolaus-asset-plan-'));
  const assetsRoot = join(root, 'assets');
  const bundlePath = join(root, 'bundle.json');
  const manifestPath = join(root, 'manifest.json');
  mkdirSync(assetsRoot, { recursive: true });
  try {
    const { sourceContract, targetContract } =
      await loadSupportedMigrationContracts(process.cwd());
    const migrationBundle = buildMigrationBundle({
      sourceContract,
      targetContract,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceRows: new Map(sourceContract.map((table) => [table.name, []])),
    });
    writeFileSync(bundlePath, `${JSON.stringify(migrationBundle)}\n`, {
      mode: 0o600,
    });
    const result = await planPredecessorAssetMigration({
      sourceRoot: process.cwd(),
      bundlePath,
      sourceAssetsRoot: assetsRoot,
      manifestPath,
    });
    assert.equal(result.status, 'planned');
    assert.deepEqual(result.counts, { assets: 0, rejected: 0 });
    assert.equal(
      readAssetMigrationManifest(manifestPath).sourceMigrationRunId,
      migrationBundle.runId,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovers only referenced resume, packet, variant, and attachment objects', async () => {
  const discovered = discoverReferencedAssets(bundle());
  assert.deepEqual(
    discovered.entries.map((entry) => entry.logicalPath),
    [
      'applications/application-1/packet.md',
      'applications/application-1/packet.pdf',
      'attachments/portfolio.pdf',
      'generated/resume-global.html',
      'generated/resume-global.md',
      'generated/resume-global.pdf',
      'generated/resume-global.txt',
      'variants/variant-1.pdf',
    ],
  );
  assert.equal(discovered.rejected.length, 0);
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: sourceFiles(),
  });
  assert.equal(manifest.entries.length, 8);
  assert.deepEqual(manifest.publishedAlias, {
    sourceId: 'resume-global',
    sourcePath: 'generated/resume-global.pdf',
    logicalPath: PUBLISHED_RESUME_ALIAS_PATH,
    byteLength: Buffer.byteLength('%PDF-global'),
    contentDigest:
      'sha256:fb9232b36427673642387f03577275925714ade43b0d0695fc444114c3645d20',
  });
  assert.deepEqual(manifest.excluded, [
    'credentials',
    'database-dumps',
    'node_modules',
    'source-checkouts',
    'unreferenced-temporary-files',
    'unreferenced-legacy-files',
    'crawler-raw-output',
    'provenance-only-path-fields',
  ]);
  assert.equal(manifest.rejected.length, 0);
  validateAssetMigrationManifest(manifest);
});

test('unsafe, missing, and ambiguous source records are quarantined before target writes', async () => {
  const unsafe = bundle({
    tables: [
      {
        name: 'attachments',
        rows: [
          {
            sourceId: 'unsafe',
            values: { id: 'unsafe', file_path: '../private-file' },
          },
        ],
      },
      {
        name: 'resume_assets',
        rows: [
          {
            sourceId: 'first-published',
            values: {
              id: 'first-published',
              application_id: '',
              is_published: true,
              pdf_path: 'generated/resume-global.pdf',
            },
          },
          {
            sourceId: 'second-published',
            values: {
              id: 'second-published',
              application_id: '',
              is_published: true,
              pdf_path: 'missing.pdf',
            },
          },
        ],
      },
    ],
  });
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: unsafe,
    sourceAssets: sourceFiles(),
  });
  assert.ok(manifest.rejected.some((item) => item.code === 'unsafe-logical-path'));
  assert.ok(manifest.rejected.some((item) => item.code === 'missing-source-asset'));
  assert.ok(
    manifest.rejected.some((item) => item.code === 'ambiguous-published-resume'),
  );
  const target = new MemoryAssets();
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    const result = await importAssetMigrationManifest({
      manifest,
      sourceAssets: sourceFiles(),
      targetAssets: target,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(target.writes.length, 0);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('copies and verifies representative resumes and application packets across restart', async () => {
  const source = sourceFiles();
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: source,
  });
  const target = new MemoryAssets();
  const store = new MetadataStore();
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    const first = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: target,
      stateRoot,
      metadataStore: store,
    });
    assert.equal(first.status, 'complete');
    assert.equal(first.counts.copied, 9);
    assert.deepEqual(
      await target.read('generated/resume-global.pdf'),
      await source.read('generated/resume-global.pdf'),
    );
    assert.deepEqual(
      await target.read('applications/application-1/packet.pdf'),
      await source.read('applications/application-1/packet.pdf'),
    );
    assert.deepEqual(
      await target.read(PUBLISHED_RESUME_ALIAS_PATH),
      await source.read('generated/resume-global.pdf'),
    );
    const writes = target.writes.length;
    const restarted = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: target,
      stateRoot,
      metadataStore: store,
    });
    assert.equal(restarted.status, 'complete');
    assert.equal(restarted.reconciliationDigest, first.reconciliationDigest);
    assert.equal(target.writes.length, writes);
    assert.ok(store.referenceCalls >= 4);
    assert.ok(store.aliasCalls >= 4);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('never overwrites a mismatched target object and records a deterministic quarantine', async () => {
  const source = sourceFiles();
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: source,
  });
  const target = new MemoryAssets({
    'applications/application-1/packet.pdf': 'different packet',
  });
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    const result = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: target,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(result.status, 'quarantined');
    assert.deepEqual(
      await target.read('applications/application-1/packet.pdf'),
      Buffer.from('different packet'),
    );
    const journal = JSON.parse(readFileSync(result.quarantinePath, 'utf8'));
    assert.equal(
      journal.rejected['applications/application-1/packet.pdf'],
      'target-checksum-conflict',
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('retries a repaired published alias without changing the manifest or journal manually', async () => {
  const source = sourceFiles();
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: source,
  });
  const target = new MemoryAssets({ [PUBLISHED_RESUME_ALIAS_PATH]: 'wrong alias' });
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    const first = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: target,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(first.status, 'quarantined');
    target.entries.set(
      PUBLISHED_RESUME_ALIAS_PATH,
      await source.read('generated/resume-global.pdf'),
    );
    const repaired = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: target,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(repaired.status, 'complete');
    assert.equal(repaired.quarantinePath, null);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('rejects target storage symlinks without writing through them', async () => {
  const source = sourceFiles();
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: source,
  });
  const targetRoot = mkdtempSync(join(tmpdir(), 'iolaus-target-assets-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'iolaus-outside-assets-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    symlinkSync(outsideRoot, join(targetRoot, 'attachments'));
    const result = await importAssetMigrationManifest({
      manifest,
      sourceAssets: source,
      targetAssets: new LocalTargetAssets(targetRoot),
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(result.status, 'quarantined');
    assert.equal(
      result.counts.rejected,
      1,
      readFileSync(result.quarantinePath, 'utf8'),
    );
    assert.throws(() => readFileSync(join(outsideRoot, 'portfolio.pdf')));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('refuses target writes when stable metadata no longer matches the manifest', async () => {
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle(),
    sourceAssets: sourceFiles(),
  });
  const target = new MemoryAssets();
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-assets-'));
  try {
    await assert.rejects(
      importAssetMigrationManifest({
        manifest,
        sourceAssets: sourceFiles(),
        targetAssets: target,
        stateRoot,
        metadataStore: new MetadataStore({ rejectReferences: true }),
      }),
      /metadata mismatch/,
    );
    assert.equal(target.writes.length, 0);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('private manifests are write-once, mode 0600, and reject tampering', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'iolaus-source-'));
  const privateRoot = mkdtempSync(join(tmpdir(), 'iolaus-private-'));
  try {
    const manifest = await buildAssetMigrationManifest({
      migrationBundle: bundle(),
      sourceAssets: sourceFiles(),
    });
    const path = join(privateRoot, 'manifest.json');
    writeAssetMigrationManifest({ sourceRoot, path, manifest });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readAssetMigrationManifest(path).manifestDigest, manifest.manifestDigest);
    chmodSync(path, 0o644);
    assert.throws(() => readAssetMigrationManifest(path), /unsafe-bundle-file/);
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(
      () => writeAssetMigrationManifest({ sourceRoot, path, manifest }),
      /asset-manifest-already-exists/,
    );
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test('reads from canonical /tmp assets, rejects symlinks, and persists through the released local provider restart', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'iolaus-source-root-'));
  const assetsRoot = mkdtempSync(join(tmpdir(), 'iolaus-source-assets-'));
  const targetRoot = mkdtempSync(join(tmpdir(), 'iolaus-target-assets-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'iolaus-asset-state-'));
  const outsidePath = join(sourceRoot, 'outside.pdf');
  try {
    for (const [path, contents] of sourceFiles().entries) {
      const destination = join(assetsRoot, path);
      mkdirSync(join(destination, '..'), { recursive: true });
      writeFileSync(destination, contents);
    }
    writeFileSync(outsidePath, 'outside');
    symlinkSync(outsidePath, join(assetsRoot, 'attachments', 'escape.pdf'));
    const linkedRoot = join(sourceRoot, 'linked-assets');
    symlinkSync(assetsRoot, linkedRoot);
    assert.throws(
      () => new LocalSourceAssets({ sourceRoot, root: linkedRoot }),
      /unsafe-source-asset-root/,
    );
    const sourceAssets = new LocalSourceAssets({ sourceRoot, root: assetsRoot });
    assert.equal(await sourceAssets.exists('attachments/escape.pdf'), true);
    await assert.rejects(
      sourceAssets.read('attachments/escape.pdf'),
      /source-asset-not-regular/,
    );
    const manifest = await buildAssetMigrationManifest({
      migrationBundle: bundle(),
      sourceAssets,
    });
    const { getFilesystem } = await import(
      pathToFileURL(
        join(
          process.cwd(),
          'apps/site/node_modules/@happyvertical/files/dist/index.js',
        ),
      ).href,
    );
    const firstTarget = await getFilesystem({ type: 'local', basePath: targetRoot });
    const first = await importAssetMigrationManifest({
      manifest,
      sourceAssets,
      targetAssets: firstTarget,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(first.status, 'complete');
    const restartedTarget = await getFilesystem({ type: 'local', basePath: targetRoot });
    const restarted = await importAssetMigrationManifest({
      manifest,
      sourceAssets: new LocalSourceAssets({ sourceRoot, root: assetsRoot }),
      targetAssets: restartedTarget,
      stateRoot,
      metadataStore: new MetadataStore(),
    });
    assert.equal(restarted.status, 'complete');
    assert.equal(restarted.reconciliationDigest, first.reconciliationDigest);
    assert.deepEqual(
      await restartedTarget.read(PUBLISHED_RESUME_ALIAS_PATH, { raw: true }),
      Buffer.from('%PDF-global'),
    );
    assert.equal(readFileSync(join(assetsRoot, 'generated/resume-global.pdf'), 'utf8'), '%PDF-global');
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(assetsRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
