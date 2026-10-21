#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArgs(args) {
  let provenance;
  let source;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--provenance') provenance = args[++index];
    else if (args[index] === '--source') source = args[++index];
    else if (args[index] === '--help') {
      console.log('Usage: node scripts/verify-ingestion-archive.mjs --provenance <path> [--source <smrt-worktree>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (!provenance) throw new Error('--provenance is required.');
  return { provenance, source };
}

export function verifyIngestionArchive({ provenancePath, sourceRoot }) {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const archivePath = resolve(dirname(provenancePath), provenance.archive);
  if (!existsSync(archivePath)) throw new Error(`Archive is missing: ${archivePath}`);
  if (sha256(readFileSync(archivePath)) !== provenance.archiveSha256) {
    throw new Error('Archive SHA-256 differs from the recorded local compatibility repack.');
  }
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], { encoding: 'utf8' }),
  );
  if (manifest.name !== provenance.package.name || manifest.version !== provenance.package.version) {
    throw new Error('Archive package identity differs from provenance.');
  }
  for (const [name, version] of Object.entries(provenance.reboundDependencies)) {
    if (manifest.dependencies?.[name] !== version) {
      throw new Error(`${name} must remain pinned to ${version} in the compatibility repack.`);
    }
  }
  if (sourceRoot) {
    const source = resolve(sourceRoot);
    const manifestAtCommit = execFileSync(
      'git',
      ['-C', source, 'show', `${provenance.source.commit}:${provenance.source.packageManifest}`],
      { encoding: 'utf8' },
    );
    if (sha256(manifestAtCommit) !== provenance.source.packageManifestSha256) {
      throw new Error('SMRT source manifest at the recorded commit differs from provenance.');
    }
  }
  return provenance;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { provenance, source } = parseArgs(process.argv.slice(2));
  const verified = verifyIngestionArchive({
    provenancePath: resolve(root, provenance),
    sourceRoot: source,
  });
  console.log(JSON.stringify({ status: 'verified-local-compatibility-repack', archive: verified.archive }));
}
