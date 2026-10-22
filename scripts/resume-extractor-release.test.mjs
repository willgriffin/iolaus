import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { candidateArgs, probe, qualifyCandidate } from './resume-extractor-candidate.mjs';

const image = `ghcr.io/willgriffin/iolaus/resume-import-extraction@sha256:${'a'.repeat(64)}`;
const revision = 'b'.repeat(40);
const lock = 'c'.repeat(64);
const workflow = readFileSync(new URL('../.github/workflows/release-image.yml', import.meta.url), 'utf8');

test('candidate requires an immutable digest and uses bounded isolated runtime', () => {
  assert.throws(() => candidateArgs('ghcr.io/willgriffin/iolaus/resume-import-extraction:latest', 'candidate'));
  const args = candidateArgs(image, 'candidate');
  for (const [flag, value] of [['--network', 'none'], ['--memory', '512m'], ['--memory-swap', '512m'], ['--cpus', '1'], ['--pids-limit', '64'], ['--cap-drop', 'ALL'], ['--user', '10001:10001']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--read-only'));
  assert.match(args[args.indexOf('--tmpfs') + 1], /size=32m/);
});

test('candidate rejects mismatched provenance before startup', () => {
  let started = false;
  assert.throws(() => qualifyCandidate(image, revision, lock, (_command, args) => {
    if (args[0] === 'run') started = true;
    if (args[0] === 'image') return JSON.stringify([{ Config: { User: '10001:10001', Labels: { 'org.opencontainers.image.revision': 'wrong' } } }]);
    return '';
  }));
  assert.equal(started, false);
});

test('embedded native probe parses as standalone Node code', () => {
  assert.doesNotThrow(() => new Function(probe));
});

test('candidate always removes its container after a failed probe', () => {
  const calls = [];
  assert.throws(() => qualifyCandidate(image, revision, lock, (_command, args) => {
    calls.push(args);
    if (args[0] === 'image') return JSON.stringify([{ Config: { User: '10001:10001', Labels: { 'org.opencontainers.image.revision': revision, 'dev.happyvertical.iolaus.pnpm-lock.sha256': lock } } }]);
    if (args[0] === 'exec') throw new Error('probe failed');
    return '';
  }), /probe failed/);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['rm', '--force']);
});

test('both candidate builds share source provenance, SBOM and registry attestation', () => {
  assert.match(workflow, /ref: refs\/tags\/\$\{\{ env.RELEASE_TAG \}\}/);
  assert.equal(workflow.match(/context: \./g)?.length, 2);
  assert.equal(workflow.match(/IOLAUS_SOURCE_REVISION=\$\{\{ steps.meta.outputs.revision \}\}/g)?.length, 2);
  assert.equal(workflow.match(/IOLAUS_LOCKFILE_SHA256=\$\{\{ steps.meta.outputs.lock_sha256 \}\}/g)?.length, 2);
  assert.equal(workflow.match(/sbom: true/g)?.length, 2);
  assert.equal(workflow.match(/provenance: mode=max/g)?.length, 2);
  assert.equal(workflow.match(/uses: actions\/attest-build-provenance@v2/g)?.length, 2);
  assert.ok(workflow.indexOf('Qualify candidate container envelope') < workflow.indexOf('Publish release tags'));
  assert.match(workflow, /production-integration-required/);
  assert.match(workflow, /path: resume-image-pair.json/);
});

test('extractor image pins Node and carries source and lock labels', () => {
  const dockerfile = readFileSync(new URL('../apps/site/Dockerfile.resume-import-extraction', import.meta.url), 'utf8');
  assert.equal(dockerfile.match(/FROM node:26\.10\.0-bookworm-slim/g)?.length, 2);
  assert.match(dockerfile, /LABEL org.opencontainers.image.revision="\$\{IOLAUS_SOURCE_REVISION\}"/);
  assert.match(dockerfile, /LABEL dev.happyvertical.iolaus.pnpm-lock.sha256="\$\{IOLAUS_LOCKFILE_SHA256\}"/);
  assert.match(probe, /production deadline exceeded/);
  assert.match(probe, /NoNewPrivs/);
});
