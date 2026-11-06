#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function assertTransitiveConsumers(lock, pkg) {
  const snapshots = lock.split(/^snapshots:\s*$/mu)[1];
  assert.ok(snapshots, 'missing pnpm lock snapshots');
  const consumers = new Set();
  let consumer;
  for (const line of snapshots.split('\n')) {
    const snapshot = /^  (?:'([^']+)'|([^ ]\S*)):(?: \{\})?$/u.exec(line);
    if (snapshot) {
      consumer = (snapshot[1] ?? snapshot[2]).split('(')[0];
    }
    // pnpm writes an alias target in the version field as package@version.
    const edge = /^      (?:'([^']+)'|(\S+)): ['"]?(?:(?:npm:)?(@happyvertical\/[^@\s]+)@)?(\d+\.\d+\.\d+)(?:[('"]|$)/u.exec(line);
    if (edge && (edge[3] ?? edge[1] ?? edge[2]) === pkg.name && edge[4] === pkg.version) {
      assert.ok(!edge[3], `${pkg.name}@${pkg.version}: restricted transitive alias under ${consumer}`);
      consumers.add(consumer);
    }
  }
  assert.deepEqual([...consumers].sort(), [...pkg.consumers].sort(), `${pkg.name}@${pkg.version}: unexpected transitive consumers`);
}

export function verifyPublishedClosure(root = resolve(import.meta.dirname, '..')) {
  const closure = JSON.parse(readFileSync(resolve(root, 'vendor/release/published-closure.json'), 'utf8'));
  assert.equal(closure.provenance, 'published-registry-metadata');
  const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
  const store = resolve(root, 'node_modules/.pnpm');
  const entries = readdirSync(store);
  const identities = [...lock.matchAll(/^  '([^'\r\n]+)':(?: \{\})?$/gmu)].map((match) => match[1]);
  const isIdentity = (identity, pkg) => {
    const exact = `${pkg.name}@${pkg.version}`;
    return identity === exact || identity.startsWith(`${exact}(`);
  };
  for (const pkg of closure.packages) {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/u);
    assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+=*$/u);
    const key = `  '${pkg.name}@${pkg.version}':\n`;
    const start = lock.indexOf(key);
    assert.ok(start >= 0, `${pkg.name}: missing published lock entry`);
    const block = lock.slice(start, lock.indexOf('\n\n', start));
    assert.ok(block.includes(`integrity: ${pkg.integrity}`), `${pkg.name}: registry integrity differs from lock`);
    const prefix = `${pkg.name.replace('/', '+')}@`;
    if (pkg.consumers) assertTransitiveConsumers(lock, pkg);
    // pnpm retains unreachable old store directories after an upgrade. Only the
    // frozen lock defines the active graph.
    const copies = entries.filter((entry) => entry === `${prefix}${pkg.version}` || entry.startsWith(`${prefix}${pkg.version}_`));
    assert.ok(copies.length > 0, `${pkg.name}: no installed package`);
    for (const entry of copies) {
      const manifest = JSON.parse(readFileSync(resolve(store, entry, 'node_modules', pkg.name, 'package.json'), 'utf8'));
      assert.equal(manifest.name, pkg.name);
      assert.equal(manifest.version, pkg.version, `${pkg.name}: incompatible installed copy ${entry}`);
    }
  }
  for (const identity of identities.filter((item) => item.startsWith('@happyvertical/'))) {
    const sameName = closure.packages.filter((pkg) => identity.startsWith(`${pkg.name}@`));
    assert.ok(sameName.length, `unrecorded first-party lock identity ${identity}`);
    assert.ok(sameName.some((pkg) => isIdentity(identity, pkg)), `incompatible lock identity ${identity}`);
  }
  for (const manifestPath of ['package.json', 'apps/site/package.json', 'packages/cli/package.json', 'packages/resume/package.json']) {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'));
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })) {
      assert.ok(!/^npm:@happyvertical\//u.test(version), `${name}: expected a published version without an alias`);
      if (!name.startsWith('@happyvertical/')) continue;
      assert.match(version, /^\d+\.\d+\.\d+$/u, `${name}: expected a published version`);
      const pkg = closure.packages.find((item) => item.name === name && !item.consumers);
      assert.ok(pkg, `${name}: missing published closure record`);
      assert.equal(version, pkg.version, `${name}: direct dependency differs from closure`);
      const installed = JSON.parse(readFileSync(resolve(root, dirname(manifestPath), 'node_modules', name, 'package.json'), 'utf8'));
      assert.equal(installed.name, name, `${name}: direct installed link differs from manifest`);
      assert.equal(installed.version, version, `${name}: direct installed link differs from manifest`);
    }
  }
  return closure.packages.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Verified ${verifyPublishedClosure()} published dependency versions, lock integrities and installed copies.`);
}
