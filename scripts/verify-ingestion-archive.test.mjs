import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { verifyIngestionArchive } from './verify-ingestion-archive.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fixture(root, dependencyVersion = '1.0.0') {
  const packageDirectory = resolve(root, 'package');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    resolve(packageDirectory, 'package.json'),
    JSON.stringify({ name: '@example/ingestion', version: '1.2.3', dependencies: { '@example/runtime': dependencyVersion } }),
  );
  const archive = resolve(root, 'ingestion.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const provenance = {
    archive: 'ingestion.tgz',
    archiveSha256: sha256(readFileSync(archive)),
    package: { name: '@example/ingestion', version: '1.2.3' },
    reboundDependencies: { '@example/runtime': '1.0.0' },
  };
  const provenancePath = resolve(root, 'provenance.json');
  writeFileSync(provenancePath, JSON.stringify(provenance));
  return provenancePath;
}

test('verifies a local compatibility archive by hash and pinned dependencies', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'iolaus-ingestion-'));
  try {
    const provenancePath = fixture(root);
    assert.equal(verifyIngestionArchive({ provenancePath }).package.name, '@example/ingestion');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an archive whose dependency binding changes', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'iolaus-ingestion-'));
  try {
    const provenancePath = fixture(root, '2.0.0');
    assert.throws(() => verifyIngestionArchive({ provenancePath }), /must remain pinned/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
