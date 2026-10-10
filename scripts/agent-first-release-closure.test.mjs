import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  collectClosure,
  discoverPackages,
  proposalFor,
  sourceIdentity,
  verifyClosure,
} from './agent-first-release-closure.mjs';

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test('collects direct, optional, and peer local dependency closure', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'iolaus-closure-'));
  try {
    mkdirSync(resolve(fixture, 'sdk'), { recursive: true });
    writeFileSync(
      resolve(fixture, 'sdk/pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
    );
    writeJson(resolve(fixture, 'sdk/packages/auth/package.json'), { name: '@example/auth', version: '1.0.0', dependencies: { '@example/utils': '1.0.0' }, peerDependencies: { '@example/plugin': '1.0.0' } });
    writeJson(resolve(fixture, 'sdk/packages/utils/package.json'), { name: '@example/utils', version: '1.0.0' });
    writeJson(resolve(fixture, 'sdk/packages/plugin/package.json'), { name: '@example/plugin', version: '1.0.0', optionalDependencies: { '@example/optional': '1.0.0' } });
    writeJson(resolve(fixture, 'sdk/packages/optional/package.json'), { name: '@example/optional', version: '1.0.0' });
    const seed = resolve(fixture, 'consumer/package.json');
    writeJson(resolve(fixture, 'sdk/docs/duplicate/package.json'), { name: '@example/auth', version: '9.9.9' });
    writeJson(seed, { name: 'consumer', devDependencies: { '@example/auth': '^1.0.0' } });
    const closure = collectClosure(discoverPackages([resolve(fixture, 'sdk')]), [seed]);
    assert.deepEqual(closure.packages.map((pkg) => pkg.name), ['@example/auth', '@example/optional', '@example/plugin', '@example/utils']);
    assert.deepEqual(closure.edges.map((edge) => `${edge.from}:${edge.field}:${edge.to}`).sort(), ['@example/auth:dependencies:@example/utils', '@example/auth:peerDependencies:@example/plugin', '@example/plugin:optionalDependencies:@example/optional']);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('seeds root CLI tooling declared in devDependencies', () => {
  const packages = new Map([
    ['@happyvertical/smrt-cli', { name: '@happyvertical/smrt-cli', version: '1.0.0', manifest: {} }],
    ['@happyvertical/smrt-dev-mcp', { name: '@happyvertical/smrt-dev-mcp', version: '1.0.0', manifest: {} }],
  ]);
  const fixture = mkdtempSync(resolve(tmpdir(), 'iolaus-seed-'));
  try {
    const rootManifest = resolve(fixture, 'package.json');
    writeJson(rootManifest, { devDependencies: { '@happyvertical/smrt-cli': '1.0.0', '@happyvertical/smrt-dev-mcp': '1.0.0' } });
    const closure = collectClosure(packages, [rootManifest]);
    assert.deepEqual(closure.packages.map((pkg) => pkg.name), ['@happyvertical/smrt-cli', '@happyvertical/smrt-dev-mcp']);
    assert.deepEqual(closure.direct.map((edge) => edge.field), ['devDependencies', 'devDependencies']);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('proposes repo-relative file overrides and only direct manifest edits', () => {
  const closure = { packages: [{ name: '@example/auth', tarballPath: '/repo/vendor/release/auth.tgz' }], direct: [{ manifestPath: '/repo/apps/site/package.json', field: 'dependencies', name: '@example/auth', spec: '^1.0.0' }] };
  assert.deepEqual(proposalFor(closure, '/repo/vendor/release', '/repo'), { overrides: { '@example/auth': 'file:vendor/release/auth.tgz' }, manifestChanges: { 'apps/site/package.json': [{ field: 'dependencies', name: '@example/auth', from: '^1.0.0', to: 'file:../../vendor/release/auth.tgz' }] }, output: 'vendor/release' });
});

test('verifier rejects tampered tarballs and wrong installed versions', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'iolaus-verify-'));
  try {
    writeFileSync(resolve(fixture, 'thing.tgz'), 'expected');
    const contents = 'expected';
    const sha512 = createHash('sha512').update(contents).digest('base64');
    writeJson(resolve(fixture, 'release-closure.json'), { packages: [{ name: '@example/thing', version: '1.0.0', tarball: 'thing.tgz', sha256: createHash('sha256').update(contents).digest('hex'), sha512, resolution: 'file:thing.tgz' }] });
    writeFileSync(resolve(fixture, 'pnpm-lock.yaml'), `resolution: { integrity: sha512-${sha512}, tarball: file:thing.tgz }\n`);
    writeJson(resolve(fixture, 'node_modules/@example/thing/package.json'), { name: '@example/thing', version: '1.0.0' });
    writeJson(resolve(fixture, 'node_modules/.pnpm/example-thing@2.0.0/node_modules/@example/thing/package.json'), { name: '@example/thing', version: '2.0.0' });
    assert.throws(() => verifyClosure(resolve(fixture, 'release-closure.json'), fixture), /example-thing@2\.0\.0[\s\S]*expected 1\.0\.0/u);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('refuses dirty source snapshots unless diagnostics explicitly allow them', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'iolaus-dirty-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixture });
    execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: fixture });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: fixture });
    writeFileSync(resolve(fixture, 'tracked'), 'clean');
    execFileSync('git', ['add', 'tracked'], { cwd: fixture });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: fixture });
    writeFileSync(resolve(fixture, 'tracked'), 'dirty');
    assert.throws(() => sourceIdentity(fixture, false), /Refusing to package dirty source/u);
    assert.equal(sourceIdentity(fixture, true).dirty, true);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
