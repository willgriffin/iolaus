import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  immutableImage,
  requirePublishedPrerequisites,
} from './adoption-candidate.mjs';

export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export function resolvePlatformManifest(
  reference,
  manifest,
  architecture = 'amd64',
) {
  assert.match(reference, /@sha256:[a-f0-9]{64}$/);
  const digest = `sha256:${sha256(manifest)}`;
  assert.equal(
    reference.split('@')[1],
    digest,
    'Registry bytes must match requested immutable digest.',
  );
  const document = JSON.parse(manifest);
  if (!document.manifests) return reference;
  const candidates = document.manifests.filter(
    ({ platform }) =>
      platform?.os === 'linux' &&
      platform.architecture === architecture &&
      !platform.variant,
  );
  assert.equal(
    candidates.length,
    1,
    'Exactly one linux platform image is required.',
  );
  assert.match(candidates[0].digest, /^sha256:[a-f0-9]{64}$/);
  return `${reference.split('@')[0]}@${candidates[0].digest}`;
}

export function assertImageMetadata(metadata, reference, revision, lock) {
  assert.ok(
    metadata.RepoDigests.includes(reference),
    'Pulled image is not the exact public artifact.',
  );
  assert.equal(metadata.Os, 'linux');
  assert.equal(metadata.Architecture, 'amd64');
  assert.equal(metadata.Config.User, '10001:10001');
  assert.equal(
    metadata.Config.Labels['org.opencontainers.image.revision'],
    revision,
  );
  assert.equal(
    metadata.Config.Labels['dev.happyvertical.iolaus.pnpm-lock.sha256'],
    lock,
  );
}

// The published runner owns hashing/canonicalization. Never copy its private API.
export async function verifyPublicArtifacts({
  prerequisites,
  runnerRoot,
  chartFile,
  run = execFileSync,
}) {
  requirePublishedPrerequisites(prerequisites);
  const git = (...args) =>
    run('git', ['-C', runnerRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  assert.equal(git('rev-parse', 'HEAD'), prerequisites.runner.revision);
  assert.equal(
    git('remote', 'get-url', 'origin'),
    prerequisites.runner.repository,
  );
  assert.equal(
    git('status', '--porcelain', '--untracked-files=all'),
    '',
    'Public runner checkout must be clean.',
  );
  assert.equal(
    sha256(readFileSync(chartFile)),
    prerequisites.chart.packageSha256,
  );
  const chartReference = `ghcr.io/happyvertical/charts/smrt-app@${prerequisites.chart.ociDigest}`;
  const manifest = run(
    'docker',
    ['buildx', 'imagetools', 'inspect', '--raw', chartReference],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(`sha256:${sha256(manifest)}`, prerequisites.chart.ociDigest);
  assert.ok(
    JSON.parse(manifest).layers.some(
      (layer) => layer.digest === `sha256:${prerequisites.chart.packageSha256}`,
    ),
    'OCI chart manifest must bind the verified package bytes.',
  );
  const module = await import(
    pathToFileURL(resolve(runnerRoot, 'scripts/deployment/release.mjs'))
  );
  assert.equal(typeof module.hash, 'function');
  assert.equal(typeof module.validateRuntime, 'function');
  return module;
}

export function resolvePublicPlatform(reference, run = execFileSync) {
  const docker = (...args) =>
    run('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
  const raw = docker('buildx', 'imagetools', 'inspect', '--raw', reference);
  const platform = resolvePlatformManifest(reference, raw);
  if (platform !== reference) {
    const bytes = docker('buildx', 'imagetools', 'inspect', '--raw', platform);
    assert.equal(`sha256:${sha256(bytes)}`, platform.split('@')[1]);
    assert.equal(JSON.parse(bytes).manifests, undefined);
  }
  docker('pull', '--platform', 'linux/amd64', platform);
  const [metadata] = JSON.parse(docker('image', 'inspect', platform));
  assert.equal(metadata.Os, 'linux');
  assert.equal(metadata.Architecture, 'amd64');
  assert.ok(metadata.RepoDigests.includes(platform));
  return { platform, metadata };
}

export function inspectPublicImage(
  reference,
  revision,
  lock,
  run = execFileSync,
) {
  const { platform, metadata } = resolvePublicPlatform(reference, run);
  assertImageMetadata(metadata, platform, revision, lock);
  return platform;
}

export function resolveImages(images, revision, lock, run) {
  return Object.fromEntries(
    Object.entries({
      site: 'ghcr.io/willgriffin/iolaus/site',
      extractor: 'ghcr.io/willgriffin/iolaus/resume-import-extraction',
    }).map(([key, repository]) => {
      immutableImage(images[key], repository);
      return [key, inspectPublicImage(images[key], revision, lock, run)];
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [imageFile, output] = process.argv.slice(2);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const lock = sha256(readFileSync('pnpm-lock.yaml'));
  writeFileSync(
    output,
    `${JSON.stringify(resolveImages(JSON.parse(readFileSync(imageFile, 'utf8')), revision, lock), null, 2)}\n`,
    { flag: 'wx' },
  );
}
