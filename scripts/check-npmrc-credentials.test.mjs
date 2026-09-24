import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { findNpmrcCredentials } from './check-npmrc-credentials.mjs';

test('allows registry routing without credentials', () => {
  assert.deepEqual(
    findNpmrcCredentials(
      '@happyvertical:registry=https://npm.happyvertical.com/\n# _authToken=comment\n',
    ),
    [],
  );
});

test('flags scoped and global credential keys without echoing values', () => {
  const findings = findNpmrcCredentials(
    [
      '@happyvertical:registry=https://npm.happyvertical.com/',
      '//npm.happyvertical.com/:_authToken=not-a-real-token',
      '_auth = dXNlcjpwYXNz',
      '//registry.example/:_password=${NPM_PASSWORD}',
      'email=owner@example.test',
      '"_authToken"=quoted',
    ].join('\n'),
  );
  assert.deepEqual(findings, [
    { key: '_authToken', line: 2 },
    { key: '_auth', line: 3 },
    { key: '_password', line: 4 },
    { key: 'email', line: 5 },
    { key: '_authToken', line: 6 },
  ]);
  assert.ok(!JSON.stringify(findings).includes('not-a-real-token'));
});

test('the committed .npmrc files carry no credentials', () => {
  execFileSync(process.execPath, ['scripts/check-npmrc-credentials.mjs'], {
    stdio: 'pipe',
  });
});
