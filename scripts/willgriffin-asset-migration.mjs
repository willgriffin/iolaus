import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getDatabase } from '@happyvertical/sql';

import {
  MAX_ASSET_COUNT,
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  readSensitiveBundle,
} from './smrt-portability-assets.mjs';
import { assertExternalArtifactPath } from './smrt-runtime-identity.mjs';

export const ASSET_MIGRATION_MANIFEST_KIND =
  'iolaus/willgriffin.dev-asset-migration';
export const ASSET_MIGRATION_MANIFEST_VERSION = 1;
export const PUBLISHED_RESUME_ALIAS_PATH = 'published/resume.pdf';

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LOGICAL_PATH_LENGTH = 512;

const FILE_REFERENCE_FIELDS = Object.freeze({
  attachments: ['file_path'],
  resume_assets: ['markdown_path', 'text_path', 'html_path', 'pdf_path'],
  resume_variants: ['markdown_path', 'text_path', 'html_path', 'pdf_path'],
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digest(value) {
  return `sha256:${sha256(value)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fail(code) {
  const error = new Error(`Asset migration failed (${code}).`);
  error.code = code;
  return error;
}

function isFailure(error) {
  return (
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    /^[a-z][a-z0-9-]*$/u.test(error.code)
  );
}

function isInside(parent, child) {
  const nested = relative(parent, child);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`);
}

/** The logical paths persisted by Iolaus must never name a host path. */
export function normalizeAssetLogicalPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_LOGICAL_PATH_LENGTH ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw fail('unsafe-logical-path');
  }
  return value;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boolValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function tableRows(bundle, name) {
  const table = bundle?.tables?.find((candidate) => candidate?.name === name);
  return Array.isArray(table?.rows) ? table.rows : [];
}

function rowValues(row) {
  return row && typeof row.values === 'object' && !Array.isArray(row.values)
    ? row.values
    : null;
}

function referenceSort(left, right) {
  return (
    left.table.localeCompare(right.table) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.field.localeCompare(right.field)
  );
}

/**
 * Select only persistent object fields that logically point at a material
 * asset. This deliberately does not walk storage, sources, checkouts, dumps,
 * crawler scratch output, credentials, or provenance-only sourcePath fields.
 */
export function discoverReferencedAssets(migrationBundle) {
  const byPath = new Map();
  const rejected = [];
  for (const [table, fields] of Object.entries(FILE_REFERENCE_FIELDS)) {
    for (const row of tableRows(migrationBundle, table)) {
      const values = rowValues(row);
      const sourceId = stringValue(row?.sourceId || values?.id);
      if (!values || !sourceId) {
        rejected.push({ code: 'invalid-metadata-reference', table, sourceId: '' });
        continue;
      }
      for (const field of fields) {
        const rawPath = stringValue(values[field]);
        if (!rawPath) continue;
        try {
          const logicalPath = normalizeAssetLogicalPath(rawPath);
          const entry = byPath.get(logicalPath) || {
            logicalPath,
            references: [],
          };
          entry.references.push({ table, sourceId, field, logicalPath });
          byPath.set(logicalPath, entry);
        } catch (error) {
          rejected.push({
            code: isFailure(error) ? error.code : 'invalid-metadata-reference',
            table,
            sourceId,
            field,
          });
        }
      }
    }
  }
  const entries = [...byPath.values()]
    .map((entry) => ({
      ...entry,
      references: entry.references.sort(referenceSort),
    }))
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  if (entries.length > MAX_ASSET_COUNT) {
    rejected.push({ code: 'too-many-referenced-assets' });
  }
  return {
    entries,
    rejected: rejected.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
  };
}

function publishedResumeReference(migrationBundle) {
  const published = tableRows(migrationBundle, 'resume_assets')
    .map((row) => ({ row, values: rowValues(row) }))
    .filter(({ values }) => values && boolValue(values.is_published))
    .filter(({ values }) => stringValue(values.application_id) === '');
  if (published.length === 0) return { publishedAlias: null, rejected: [] };
  if (published.length !== 1) {
    return {
      publishedAlias: null,
      rejected: [{ code: 'ambiguous-published-resume' }],
    };
  }
  const { row, values } = published[0];
  const sourceId = stringValue(row.sourceId || values.id);
  try {
    const sourcePath = normalizeAssetLogicalPath(stringValue(values.pdf_path));
    return {
      publishedAlias: { sourceId, sourcePath },
      rejected: [],
    };
  } catch (error) {
    return {
      publishedAlias: null,
      rejected: [{
        code: isFailure(error) ? error.code : 'published-resume-missing-pdf',
        table: 'resume_assets',
        sourceId,
        field: 'pdf_path',
      }],
    };
  }
}

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function readSourceAsset(sourceAssets, logicalPath) {
  try {
    if (!(await sourceAssets.exists(logicalPath))) throw fail('missing-source-asset');
    const value = bytes(await sourceAssets.read(logicalPath, { raw: true }));
    if (value.byteLength > MAX_ASSET_BYTES) throw fail('source-asset-too-large');
    return value;
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('source-read-failed');
  }
}

function manifestDigest(manifest) {
  const { manifestDigest: ignored, ...withoutDigest } = manifest;
  return digest(Buffer.from(canonicalJson(withoutDigest)));
}

/**
 * Build a deterministic, byte-verified private manifest from logical source
 * records. Invalid records are retained only as reason codes in quarantine.
 */
export async function buildAssetMigrationManifest({ migrationBundle, sourceAssets }) {
  const discovered = discoverReferencedAssets(migrationBundle);
  const rejected = [...discovered.rejected];
  const entries = [];
  let totalByteLength = 0;
  const candidates = rejected.some(
    (item) => item.code === 'too-many-referenced-assets',
  )
    ? []
    : discovered.entries;
  for (const candidate of candidates) {
    try {
      const contents = await readSourceAsset(sourceAssets, candidate.logicalPath);
      totalByteLength += contents.byteLength;
      if (totalByteLength > MAX_TOTAL_ASSET_BYTES) {
        rejected.push({ code: 'referenced-assets-too-large' });
        break;
      }
      entries.push({
        logicalPath: candidate.logicalPath,
        byteLength: contents.byteLength,
        contentDigest: digest(contents),
        references: candidate.references,
      });
    } catch (error) {
      rejected.push({
        code: isFailure(error) ? error.code : 'source-read-failed',
        logicalPath: candidate.logicalPath,
      });
    }
  }
  const selected = publishedResumeReference(migrationBundle);
  rejected.push(...selected.rejected);
  let publishedAlias = null;
  if (selected.publishedAlias) {
    const entry = entries.find(
      (candidate) => candidate.logicalPath === selected.publishedAlias.sourcePath,
    );
    if (!entry) {
      rejected.push({
        code: 'published-resume-file-unavailable',
        sourceId: selected.publishedAlias.sourceId,
      });
    } else {
      // A present legacy alias is a useful integrity signal, but absence is
      // allowed: the target alias is generated from the selected immutable PDF.
      if (selected.publishedAlias.sourcePath !== PUBLISHED_RESUME_ALIAS_PATH) {
        try {
          if (await sourceAssets.exists(PUBLISHED_RESUME_ALIAS_PATH)) {
            const alias = await readSourceAsset(
              sourceAssets,
              PUBLISHED_RESUME_ALIAS_PATH,
            );
            if (digest(alias) !== entry.contentDigest) {
              rejected.push({
                code: 'published-alias-source-mismatch',
                sourceId: selected.publishedAlias.sourceId,
              });
            }
          }
        } catch (error) {
          rejected.push({
            code: isFailure(error) ? error.code : 'published-alias-unreadable',
            sourceId: selected.publishedAlias.sourceId,
          });
        }
      }
      publishedAlias = {
        sourceId: selected.publishedAlias.sourceId,
        sourcePath: selected.publishedAlias.sourcePath,
        logicalPath: PUBLISHED_RESUME_ALIAS_PATH,
        byteLength: entry.byteLength,
        contentDigest: entry.contentDigest,
      };
    }
  }
  const sourceFingerprint = stringValue(migrationBundle?.sourceFingerprint);
  const sourceRunId = stringValue(migrationBundle?.runId);
  if (!HEX_SHA256.test(sourceFingerprint) || !sourceRunId.startsWith('wgd-')) {
    throw fail('unsupported-logical-migration-bundle');
  }
  const manifest = {
    kind: ASSET_MIGRATION_MANIFEST_KIND,
    schemaVersion: ASSET_MIGRATION_MANIFEST_VERSION,
    sourceMigrationRunId: sourceRunId,
    sourceFingerprint,
    runId: `wgd-assets-${sha256(
      canonicalJson({
        sourceFingerprint,
        entries,
        publishedAlias,
      }),
    )}`,
    entries: entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath)),
    publishedAlias,
    rejected: rejected.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    ),
    excluded: [
      'credentials',
      'database-dumps',
      'node_modules',
      'source-checkouts',
      'unreferenced-temporary-files',
      'unreferenced-legacy-files',
      'crawler-raw-output',
      'provenance-only-path-fields',
    ],
  };
  return { ...manifest, manifestDigest: manifestDigest(manifest) };
}

function validateReference(reference) {
  return (
    reference &&
    Object.hasOwn(FILE_REFERENCE_FIELDS, reference.table) &&
    typeof reference.sourceId === 'string' &&
    reference.sourceId.length > 0 &&
    FILE_REFERENCE_FIELDS[reference.table].includes(reference.field) &&
    normalizeAssetLogicalPath(reference.logicalPath) === reference.logicalPath
  );
}

export function validateAssetMigrationManifest(manifest) {
  if (
    !manifest ||
    manifest.kind !== ASSET_MIGRATION_MANIFEST_KIND ||
    manifest.schemaVersion !== ASSET_MIGRATION_MANIFEST_VERSION ||
    !HEX_SHA256.test(manifest.sourceFingerprint || '') ||
    typeof manifest.sourceMigrationRunId !== 'string' ||
    typeof manifest.runId !== 'string' ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > MAX_ASSET_COUNT ||
    !Array.isArray(manifest.rejected) ||
    !Array.isArray(manifest.excluded) ||
    !DIGEST.test(manifest.manifestDigest || '')
  ) {
    throw fail('invalid-asset-migration-manifest');
  }
  if (manifest.manifestDigest !== manifestDigest(manifest)) {
    throw fail('asset-manifest-digest-mismatch');
  }
  const paths = new Set();
  let totalByteLength = 0;
  for (const entry of manifest.entries) {
    if (
      !entry ||
      normalizeAssetLogicalPath(entry.logicalPath) !== entry.logicalPath ||
      paths.has(entry.logicalPath) ||
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > MAX_ASSET_BYTES ||
      !DIGEST.test(entry.contentDigest || '') ||
      !Array.isArray(entry.references) ||
      entry.references.length === 0 ||
      entry.references.some((reference) => !validateReference(reference))
    ) {
      throw fail('invalid-asset-migration-manifest');
    }
    totalByteLength += entry.byteLength;
    if (totalByteLength > MAX_TOTAL_ASSET_BYTES) {
      throw fail('invalid-asset-migration-manifest');
    }
    paths.add(entry.logicalPath);
  }
  if (manifest.publishedAlias) {
    const alias = manifest.publishedAlias;
    if (
      typeof alias.sourceId !== 'string' ||
      normalizeAssetLogicalPath(alias.sourcePath) !== alias.sourcePath ||
      alias.logicalPath !== PUBLISHED_RESUME_ALIAS_PATH ||
      !Number.isSafeInteger(alias.byteLength) ||
      alias.byteLength < 0 ||
      !DIGEST.test(alias.contentDigest || '') ||
      !manifest.entries.some(
        (entry) =>
          entry.logicalPath === alias.sourcePath &&
          entry.contentDigest === alias.contentDigest &&
          entry.byteLength === alias.byteLength,
      )
    ) {
      throw fail('invalid-published-resume-alias');
    }
  }
  return manifest;
}

function privateFile(path, code) {
  try {
    const details = lstatSync(path);
    if (
      details.isSymbolicLink() ||
      !details.isFile() ||
      (process.platform !== 'win32' && (details.mode & 0o077) !== 0)
    ) {
      throw fail(code);
    }
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail(code);
  }
}

function writePrivateNewFile(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error?.code === 'EEXIST') throw fail('asset-manifest-already-exists');
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeAssetMigrationManifest({ sourceRoot, path, manifest }) {
  validateAssetMigrationManifest(manifest);
  const destination = assertExternalArtifactPath({
    sourceRoot,
    path,
    label: 'Asset migration manifest destination',
  });
  if (existsSync(destination)) throw fail('asset-manifest-already-exists');
  writePrivateNewFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

export function readAssetMigrationManifest(path) {
  try {
    return validateAssetMigrationManifest(JSON.parse(readSensitiveBundle(path)));
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('invalid-asset-migration-manifest');
  }
}

function journalPath(stateRoot, runId) {
  return resolve(stateRoot, `.willgriffin-asset-migration-${sha256(runId).slice(0, 20)}.json`);
}

function emptyJournal(manifest) {
  return {
    schemaVersion: 1,
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    completed: {},
    rejected: {},
  };
}

function writeJournal(path, journal) {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJournal(path, manifest) {
  if (!existsSync(path)) return emptyJournal(manifest);
  privateFile(path, 'unsafe-asset-migration-journal');
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    if (
      journal?.schemaVersion !== 1 ||
      journal.runId !== manifest.runId ||
      journal.manifestDigest !== manifest.manifestDigest ||
      !journal.completed ||
      typeof journal.completed !== 'object' ||
      !journal.rejected ||
      typeof journal.rejected !== 'object'
    ) {
      throw fail('asset-migration-journal-mismatch');
    }
    return journal;
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('invalid-asset-migration-journal');
  }
}

function journalDigest(journal) {
  return digest(Buffer.from(canonicalJson({ completed: journal.completed, rejected: journal.rejected })));
}

async function targetContents(targetAssets, logicalPath) {
  try {
    if (!(await targetAssets.exists(logicalPath))) return null;
    const contents = bytes(await targetAssets.read(logicalPath, { raw: true }));
    if (contents.byteLength > MAX_ASSET_BYTES) throw fail('target-asset-too-large');
    return contents;
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('target-read-failed');
  }
}

async function writeTargetAsset(targetAssets, logicalPath, contents) {
  try {
    await targetAssets.write(logicalPath, contents, { createParents: true });
    const written = await targetContents(targetAssets, logicalPath);
    if (!written || digest(written) !== digest(contents)) {
      throw fail('target-checksum-mismatch');
    }
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('target-write-failed');
  }
}

function referencesForDestination(entry) {
  return entry.references.map(({ table, sourceId, field, logicalPath }) => ({
    table,
    sourceId,
    field,
    logicalPath,
  }));
}

/**
 * Copy an already verified manifest without overwriting a non-identical target
 * object. The journal provides deterministic restart and quarantine evidence.
 */
export async function importAssetMigrationManifest({
  manifest,
  sourceAssets,
  targetAssets,
  stateRoot,
  metadataStore,
}) {
  validateAssetMigrationManifest(manifest);
  if (!sourceAssets || !targetAssets || !stateRoot || !metadataStore) {
    throw fail('asset-migration-context-required');
  }
  const path = journalPath(stateRoot, manifest.runId);
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  let journal = readJournal(path, manifest);
  const initialRejections = manifest.rejected.map((item) => canonicalJson(item));
  for (const rejected of initialRejections) journal.rejected[rejected] = 'manifest-rejected';
  writeJournal(path, journal);
  if (initialRejections.length > 0) {
    return {
      schemaVersion: 1,
      status: 'quarantined',
      runId: manifest.runId,
      manifestDigest: manifest.manifestDigest,
      counts: { copied: 0, skipped: 0, rejected: initialRejections.length },
      reconciliationDigest: journalDigest(journal),
      quarantinePath: path,
      secretValuesIncluded: false,
    };
  }
  await metadataStore.verifyReferences(manifest.entries.flatMap(referencesForDestination));
  await metadataStore.verifyPublishedAlias(manifest.publishedAlias);
  const counts = { copied: 0, skipped: 0, rejected: 0 };
  for (const entry of manifest.entries) {
    const key = entry.logicalPath;
    if (journal.completed[key]) {
      counts.skipped += 1;
      continue;
    }
    try {
      const source = await readSourceAsset(sourceAssets, entry.logicalPath);
      if (source.byteLength !== entry.byteLength || digest(source) !== entry.contentDigest) {
        throw fail('source-checksum-mismatch');
      }
      const existing = await targetContents(targetAssets, entry.logicalPath);
      if (existing) {
        if (
          existing.byteLength !== entry.byteLength ||
          digest(existing) !== entry.contentDigest
        ) {
          throw fail('target-checksum-conflict');
        }
        journal.completed[key] = true;
        delete journal.rejected[key];
        counts.skipped += 1;
      } else {
        await writeTargetAsset(targetAssets, entry.logicalPath, source);
        journal.completed[key] = true;
        delete journal.rejected[key];
        counts.copied += 1;
      }
    } catch (error) {
      const code = isFailure(error) ? error.code : 'asset-copy-failed';
      journal.rejected[key] = code;
      counts.rejected += 1;
    }
    writeJournal(path, journal);
  }
  if (manifest.publishedAlias) {
    const alias = manifest.publishedAlias;
    try {
      const source = await readSourceAsset(sourceAssets, alias.sourcePath);
      if (
        source.byteLength !== alias.byteLength ||
        digest(source) !== alias.contentDigest
      ) {
        throw fail('source-checksum-mismatch');
      }
      const existing = await targetContents(targetAssets, alias.logicalPath);
      if (existing) {
        if (
          existing.byteLength !== alias.byteLength ||
          digest(existing) !== alias.contentDigest
        ) {
          throw fail('target-published-alias-conflict');
        }
        journal.completed[alias.logicalPath] = true;
        delete journal.rejected[alias.logicalPath];
        counts.skipped += 1;
      } else {
        await writeTargetAsset(targetAssets, alias.logicalPath, source);
        journal.completed[alias.logicalPath] = true;
        delete journal.rejected[alias.logicalPath];
        counts.copied += 1;
      }
    } catch (error) {
      journal.rejected[PUBLISHED_RESUME_ALIAS_PATH] = isFailure(error)
        ? error.code
        : 'published-alias-copy-failed';
      counts.rejected += 1;
    }
    writeJournal(path, journal);
  }
  await metadataStore.verifyReferences(manifest.entries.flatMap(referencesForDestination));
  await metadataStore.verifyPublishedAlias(manifest.publishedAlias);
  const verificationFailures = [];
  for (const entry of manifest.entries) {
    if (journal.rejected[entry.logicalPath]) continue;
    const target = await targetContents(targetAssets, entry.logicalPath);
    if (
      !target ||
      target.byteLength !== entry.byteLength ||
      digest(target) !== entry.contentDigest
    ) {
      verificationFailures.push(entry.logicalPath);
    }
  }
  if (manifest.publishedAlias && !journal.rejected[PUBLISHED_RESUME_ALIAS_PATH]) {
    const alias = manifest.publishedAlias;
    const target = await targetContents(targetAssets, alias.logicalPath);
    if (
      !target ||
      target.byteLength !== alias.byteLength ||
      digest(target) !== alias.contentDigest
    ) {
      verificationFailures.push(alias.logicalPath);
    }
  }
  for (const key of verificationFailures) journal.rejected[key] = 'target-verification-failed';
  if (verificationFailures.length > 0) writeJournal(path, journal);
  const rejected = Object.keys(journal.rejected).length;
  return {
    schemaVersion: 1,
    status: rejected === 0 ? 'complete' : 'quarantined',
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    counts: { ...counts, rejected },
    reconciliationDigest: journalDigest(journal),
    quarantinePath: rejected === 0 ? null : path,
    secretValuesIncluded: false,
  };
}

export class LocalSourceAssets {
  constructor({ sourceRoot, root }) {
    try {
      if (!isAbsolute(root)) throw fail('source-asset-root-required');
      if (lstatSync(root).isSymbolicLink()) {
        throw fail('unsafe-source-asset-root');
      }
      this.sourceRoot = realpathSync(sourceRoot);
      this.root = realpathSync(root);
      if (this.root === this.sourceRoot || isInside(this.sourceRoot, this.root)) {
        throw fail('unsafe-source-asset-root');
      }
      const details = lstatSync(this.root);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw fail('unsafe-source-asset-root');
      }
    } catch (error) {
      if (isFailure(error)) throw error;
      throw fail('unsafe-source-asset-root');
    }
  }

  path(logicalPath) {
    const resolved = resolve(this.root, normalizeAssetLogicalPath(logicalPath));
    if (!isInside(this.root, resolved)) throw fail('unsafe-logical-path');
    return resolved;
  }

  async exists(logicalPath) {
    return existsSync(this.path(logicalPath));
  }

  async read(logicalPath) {
    const path = this.path(logicalPath);
    let descriptor;
    try {
      const details = lstatSync(path);
      if (details.isSymbolicLink() || !details.isFile()) throw fail('source-asset-not-regular');
      if (!isInside(this.root, realpathSync(path))) throw fail('source-asset-outside-root');
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== details.size) {
        throw fail('source-asset-changed-during-read');
      }
      const contents = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        contents.byteLength !== opened.size ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        !isInside(this.root, realpathSync(path))
      ) {
        throw fail('source-asset-changed-during-read');
      }
      return contents;
    } catch (error) {
      if (isFailure(error)) throw error;
      throw fail('missing-source-asset');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

/**
 * The released local provider follows host symlinks. Migration must not: a
 * compromised target root must not turn a logical copy into a source write.
 */
export class LocalTargetAssets {
  constructor(root) {
    try {
      const requestedRoot = resolve(root);
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      const details = lstatSync(requestedRoot);
      this.root = realpathSync(requestedRoot);
      if (
        details.isSymbolicLink() ||
        !details.isDirectory()
      ) {
        throw fail('unsafe-target-asset-root');
      }
    } catch (error) {
      if (isFailure(error)) throw error;
      throw fail('unsafe-target-asset-root');
    }
  }

  path(logicalPath, { createParents = false } = {}) {
    const logical = normalizeAssetLogicalPath(logicalPath);
    const parts = logical.split('/');
    let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try {
        const details = lstatSync(parent);
        if (
          details.isSymbolicLink() ||
          !details.isDirectory() ||
          realpathSync(parent) !== parent
        ) {
          throw fail('unsafe-target-asset-path');
        }
      } catch (error) {
        if (isFailure(error)) throw error;
        if (!createParents && error?.code === 'ENOENT') {
          return resolve(this.root, logical);
        }
        if (!createParents || error?.code !== 'ENOENT') {
          throw fail('unsafe-target-asset-path');
        }
        try {
          mkdirSync(parent, { mode: 0o700 });
          if (realpathSync(parent) !== parent) throw fail('unsafe-target-asset-path');
        } catch (mkdirError) {
          if (isFailure(mkdirError)) throw mkdirError;
          throw fail('unsafe-target-asset-path');
        }
      }
    }
    const destination = join(parent, parts.at(-1));
    if (!isInside(this.root, destination)) throw fail('unsafe-logical-path');
    return destination;
  }

  async exists(logicalPath) {
    const destination = this.path(logicalPath);
    try {
      const details = lstatSync(destination);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw fail('unsafe-target-asset-path');
      }
      if (details.size > MAX_ASSET_BYTES) throw fail('target-asset-too-large');
      return true;
    } catch (error) {
      if (isFailure(error)) throw error;
      if (error?.code === 'ENOENT') return false;
      throw fail('target-read-failed');
    }
  }

  async read(logicalPath) {
    const destination = this.path(logicalPath);
    let descriptor;
    try {
      const details = lstatSync(destination);
      if (details.isSymbolicLink() || !details.isFile()) {
        throw fail('unsafe-target-asset-path');
      }
      descriptor = openSync(
        destination,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== details.dev ||
        opened.ino !== details.ino ||
        opened.size !== details.size
      ) {
        throw fail('target-asset-changed-during-read');
      }
      const contents = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        contents.byteLength !== opened.size
      ) {
        throw fail('target-asset-changed-during-read');
      }
      return contents;
    } catch (error) {
      if (isFailure(error)) throw error;
      throw fail('target-read-failed');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  async write(logicalPath, contents) {
    const destination = this.path(logicalPath, { createParents: true });
    let descriptor;
    try {
      descriptor = openSync(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      const buffer = bytes(contents);
      let offset = 0;
      while (offset < buffer.byteLength) {
        offset += writeSync(descriptor, buffer, offset, buffer.byteLength - offset);
      }
      fsyncSync(descriptor);
    } catch (error) {
      if (isFailure(error)) throw error;
      if (error?.code === 'EEXIST') throw fail('target-asset-raced');
      throw fail('target-write-failed');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function parseFilesystemConfig(value, label, sourceRoot) {
  let config;
  try {
    config = JSON.parse(value);
  } catch {
    throw fail(`${label}-config-invalid`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw fail(`${label}-config-invalid`);
  }
  if (config.type === 'local') {
    if (!isAbsolute(config.basePath || '')) throw fail(`${label}-config-invalid`);
    config.basePath = assertExternalArtifactPath({
      sourceRoot,
      path: config.basePath,
      label: `${label} asset storage root`,
    });
  }
  if (typeof config.type !== 'string' || config.type.length === 0) {
    throw fail(`${label}-config-invalid`);
  }
  return config;
}

async function configuredTargetAssets({ config }) {
  // This root-level operational script intentionally resolves the same pinned,
  // released provider package that the site runtime already owns. It does not
  // depend on a framework checkout or add a second deployment dependency.
  if (config.type === 'local') return new LocalTargetAssets(config.basePath);
  // The released generic providers overwrite on write and expose no atomic
  // create operation. Fail closed until the configured provider exposes one.
  throw fail('target-assets-provider-no-atomic-create');
}

function quoteIdentifier(value) {
  if (!SAFE_IDENTIFIER.test(value)) throw fail('unsafe-metadata-identifier');
  return `"${value}"`;
}

/** Read-only validation against the target's already-imported stable IDs. */
export class PostgresAssetMetadataStore {
  constructor(db) {
    this.db = db;
  }

  async verifyReferences(references) {
    for (const reference of references) {
      const result = await this.db.query(
        `SELECT ${quoteIdentifier(reference.field)} AS value
         FROM ${quoteIdentifier(reference.table)}
         WHERE ${quoteIdentifier('id')} = ?`,
        [reference.sourceId],
      );
      if (result.rows.length !== 1 || stringValue(result.rows[0]?.value) !== reference.logicalPath) {
        throw fail('target-metadata-reference-mismatch');
      }
    }
  }

  async verifyPublishedAlias(alias) {
    if (!alias) return;
    const result = await this.db.query(
      `SELECT id, pdf_path
       FROM resume_assets
       WHERE is_published = TRUE AND application_id = ''`,
    );
    if (
      result.rows.length !== 1 ||
      stringValue(result.rows[0]?.id) !== alias.sourceId ||
      stringValue(result.rows[0]?.pdf_path) !== alias.sourcePath
    ) {
      throw fail('target-published-resume-mismatch');
    }
  }
}

export async function planPredecessorAssetMigration(context) {
  if (!context.bundlePath || !context.sourceAssetsRoot || !context.manifestPath) {
    throw fail('asset-migration-plan-usage');
  }
  const migration = await import('./willgriffin-migration.mjs');
  const { sourceContract, targetContract } =
    await migration.loadSupportedMigrationContracts(context.sourceRoot);
  const bundle = migration.parseMigrationBundle(readSensitiveBundle(context.bundlePath));
  migration.validateMigrationBundle(bundle, sourceContract, targetContract);
  const manifest = await buildAssetMigrationManifest({
    migrationBundle: bundle,
    sourceAssets: new LocalSourceAssets({
      sourceRoot: context.sourceRoot,
      root: context.sourceAssetsRoot,
    }),
  });
  writeAssetMigrationManifest({
    sourceRoot: context.sourceRoot,
    path: context.manifestPath,
    manifest,
  });
  return {
    status: manifest.rejected.length === 0 ? 'planned' : 'quarantined',
    runId: manifest.runId,
    manifestDigest: manifest.manifestDigest,
    counts: { assets: manifest.entries.length, rejected: manifest.rejected.length },
    secretValuesIncluded: false,
  };
}

export async function importPredecessorAssetMigration(context) {
  if (!context.manifestPath || !context.sourceAssetsRoot || !context.targetAssetsConfigJson) {
    throw fail('asset-migration-import-usage');
  }
  if (context.runtime?.providers?.database?.engine !== 'postgres') {
    throw fail('asset-migration-target-postgres-required');
  }
  const manifest = readAssetMigrationManifest(context.manifestPath);
  const targetConfig = parseFilesystemConfig(
    context.targetAssetsConfigJson,
    'target-assets',
    context.sourceRoot,
  );
  if (
    targetConfig.type === 'local' &&
    (resolve(targetConfig.basePath) === resolve(context.sourceAssetsRoot) ||
      isInside(resolve(context.sourceAssetsRoot), resolve(targetConfig.basePath)))
  ) {
    throw fail('target-asset-root-overlaps-source');
  }
  try {
    const db = await getDatabase({ type: 'postgres', url: context.env.DATABASE_URL });
    try {
      return await importAssetMigrationManifest({
        manifest,
        sourceAssets: new LocalSourceAssets({
          sourceRoot: context.sourceRoot,
          root: context.sourceAssetsRoot,
        }),
        targetAssets: await configuredTargetAssets({
          config: targetConfig,
        }),
        stateRoot: context.stateRoot,
        metadataStore: new PostgresAssetMetadataStore(db),
      });
    } finally {
      await db.close?.();
    }
  } catch (error) {
    if (isFailure(error)) throw error;
    throw fail('target-asset-migration-operation-failed');
  }
}
