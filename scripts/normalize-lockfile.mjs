#!/usr/bin/env node
/**
 * Normalize pnpm-lock.yaml so every @happyvertical package entry is fetchable
 * from GitHub Packages on a cold store (i.e. in CI).
 *
 * WHY THIS EXISTS
 * ---------------
 * @happyvertical packages live on GitHub Packages, which serves tarballs only
 * at `/download/<pkg>/<version>/<sha>` — NOT the conventional npm path
 * `<registry>/<pkg>/-/<pkg>-<version>.tgz`. We pin each package to its download
 * URL via root package.json `pnpm.overrides`.
 *
 * `overrides` rewrite direct/transitive dependency edges, but pnpm does NOT
 * apply them to peerDependency resolution. The smrt packages declare each other
 * as peers (e.g. smrt-svelte peer-depends on smrt-users; smrt-scanner peer-
 * depends on smrt-core), and some (smrt-agents, smrt-jobs) are referenced ONLY
 * as peers. pnpm resolves those peers against the scoped registry and writes
 * plain-version, integrity-only entries with NO `tarball` field. Under
 * `pnpm install --frozen-lockfile` it then reconstructs the conventional path,
 * which 404s on GitHub Packages — but only on a cold store, so it passes
 * locally (warm store) and fails in CI.
 *
 * This script injects the authoritative `/download/...` tarball URL (from
 * pnpm.overrides) into every integrity-only @happyvertical entry. Integrity is
 * preserved, so pnpm still verifies the download.
 *
 * WHEN TO RUN
 * -----------
 * After regenerating pnpm-lock.yaml (e.g. `pnpm install` following a version
 * bump in pnpm.overrides). Idempotent: re-running once tarballs are present is
 * a no-op. CI runs only `--frozen-lockfile` and never regenerates, so it does
 * not need this script — but the committed lockfile must already be normalized.
 *
 *   node scripts/normalize-lockfile.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(root, 'pnpm-lock.yaml');
const pkgPath = resolve(root, 'package.json');

const overrides = JSON.parse(readFileSync(pkgPath, 'utf8')).pnpm.overrides;

// Authoritative tarball URL keyed by "<pkg>@<version>", from pnpm.overrides.
const dlRe =
  /^https:\/\/npm\.pkg\.github\.com\/download\/(@happyvertical\/[a-z0-9-]+)\/([0-9][^/]*)\/[0-9a-f]+$/;
const tarballByPv = new Map();
for (const spec of Object.values(overrides)) {
  const m = spec.match(dlRe);
  if (m) tarballByPv.set(`${m[1]}@${m[2]}`, spec);
}

const lines = readFileSync(lockPath, 'utf8').split('\n');
const plainKeyRe = /^ {2}'(@happyvertical\/[a-z0-9-]+)@([0-9][^'(]*)':$/;
const resRe = /^( {4}resolution: \{integrity: )(sha512-[^},]+)(\})$/;

const out = [];
const injected = [];
for (let i = 0; i < lines.length; i++) {
  out.push(lines[i]);
  const km = lines[i].match(plainKeyRe);
  if (km && i + 1 < lines.length) {
    const key = `${km[1]}@${km[2]}`;
    const rm = lines[i + 1].match(resRe);
    if (rm && tarballByPv.has(key)) {
      out.push(`${rm[1]}${rm[2]}, tarball: ${tarballByPv.get(key)}${rm[3]}`);
      injected.push(key);
      i += 1;
    }
  }
}

writeFileSync(lockPath, out.join('\n'));
console.log(
  `Injected tarball into ${injected.length} plain-form @happyvertical entries:`,
);
for (const e of injected) console.log(`  ${e}`);
if (injected.length === 0) console.log('  (none — lockfile already normalized)');
