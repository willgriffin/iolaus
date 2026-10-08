#!/usr/bin/env node
/**
 * Make a reproducible, local tarball closure for first-party packages that are
 * not available from the configured registry yet.  It deliberately writes a
 * proposal instead of editing package.json or pnpm-lock.yaml.
 *
 * Example:
 * node scripts/agent-first-release-closure.mjs \
 *   --source /path/to/sdk --source /path/to/smrt \
 *   --seed package.json --seed apps/site/package.json \
 *   --seed packages/cli/package.json --seed packages/resume/package.json \
 *   --output vendor/release
 *
 * Run only after both source worktrees are clean at their release commits.
 * The generated proposal is intentionally an input for a separate, reviewed
 * manifest/lockfile change; it never writes package manifests itself.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

function workspacePackageManifests(root) {
  const workspace = resolve(root, 'pnpm-workspace.yaml');
  if (!existsSync(workspace)) throw new Error(`Missing pnpm-workspace.yaml in source: ${root}`);
  const patterns = [...readFileSync(workspace, 'utf8').matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/gmu)]
    .map((match) => match[1])
    // Release closure packages live under packages/.  Documentation and test
    // fixtures may legitimately duplicate names and must not enter a release.
    .filter((pattern) => pattern === 'packages' || pattern.startsWith('packages/'));
  const manifests = new Set();
  for (const pattern of patterns) {
    const parts = pattern.split('/');
    let directories = [root];
    for (const part of parts) {
      directories = directories.flatMap((directory) => {
        if (part !== '*') return [resolve(directory, part)];
        return readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
          .map((entry) => resolve(directory, entry.name));
      });
    }
    for (const directory of directories) {
      const manifest = resolve(directory, 'package.json');
      if (existsSync(manifest)) manifests.add(manifest);
    }
  }
  return [...manifests].sort();
}

/** Discover every publishable workspace package in the supplied source trees. */
export function discoverPackages(sourceRoots) {
  const packages = new Map();
  for (const sourceRoot of sourceRoots) {
    const source = resolve(sourceRoot);
    if (!existsSync(source)) throw new Error(`Source does not exist: ${source}`);
    for (const manifestPath of workspacePackageManifests(source)) {
      const manifest = json(manifestPath);
      if (!manifest.name || manifest.private) continue;
      if (packages.has(manifest.name)) {
        throw new Error(`Duplicate local package ${manifest.name}: ${packages.get(manifest.name).manifestPath} and ${manifestPath}`);
      }
      packages.set(manifest.name, {
        name: manifest.name,
        version: manifest.version,
        manifest,
        manifestPath,
        directory: dirname(manifestPath),
        sourceRoot: source,
      });
    }
  }
  return packages;
}

/** Resolve local dependencies, including optional and peer edges. */
export function collectClosure(packages, seedManifestPaths) {
  const queue = [];
  const direct = [];
  for (const seedPath of seedManifestPaths) {
    const manifest = json(seedPath);
    for (const field of [...dependencyFields, 'devDependencies']) {
      for (const [name, spec] of Object.entries(manifest[field] || {})) {
        if (packages.has(name)) {
          queue.push(name);
          direct.push({ manifestPath: seedPath, field, name, spec });
        }
      }
    }
  }
  const selected = new Map();
  const edges = [];
  while (queue.length) {
    const name = queue.shift();
    if (selected.has(name)) continue;
    const entry = packages.get(name);
    if (!entry) continue;
    if (!entry.version) throw new Error(`${name} has no version in ${entry.manifestPath}`);
    selected.set(name, entry);
    for (const field of dependencyFields) {
      for (const [dependency, spec] of Object.entries(entry.manifest[field] || {})) {
        if (!packages.has(dependency)) continue;
        edges.push({ from: name, to: dependency, field, spec });
        queue.push(dependency);
      }
    }
  }
  return { packages: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)), edges, direct };
}

function git(sourceRoot, args) {
  return execFileSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }).trim();
}

export function sourceIdentity(sourceRoot, allowDirty) {
  const commit = git(sourceRoot, ['rev-parse', 'HEAD']);
  const dirty = git(sourceRoot, ['status', '--porcelain=v1']);
  if (dirty && !allowDirty) {
    throw new Error(`Refusing to package dirty source ${sourceRoot}. Commit or stash it, or use --allow-dirty for diagnostics only.`);
  }
  return { path: sourceRoot, commit, dirty: Boolean(dirty) };
}

function parseArgs(args) {
  const values = { source: [], seed: [], allowDirty: false, verify: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-dirty') values.allowDirty = true;
    else if (arg === '--verify') values.verify = true;
    else if (['--source', '--seed', '--output', '--manifest', '--install-root'].includes(arg)) {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--source' || arg === '--seed') values[arg.slice(2)].push(value);
      else values[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (arg === '--help') values.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return values;
}

function pack(entry, output) {
  const temporary = resolve(output, '.agent-first-pack-tmp', entry.name.replaceAll('/', '__'));
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    // pnpm runs prepack here, so a missing build artifact fails honestly.
    execFileSync('pnpm', ['pack', '--pack-destination', temporary], {
      cwd: entry.directory,
      stdio: 'inherit',
    });
    const created = readdirSync(temporary).filter((name) => name.endsWith('.tgz'));
    if (created.length !== 1) {
      throw new Error(`Expected pnpm pack for ${entry.name} to create one tarball; got ${created.join(', ') || 'none'}`);
    }
    const target = resolve(output, created[0]);
    renameSync(resolve(temporary, created[0]), target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function portable(root, path) {
  return relative(root, path).split(sep).join('/');
}

export function proposalFor(closure, output, root = repositoryRoot) {
  const overrides = {};
  const manifestChanges = {};
  for (const entry of closure.packages) {
    const file = entry.tarballPath;
    if (!file) continue;
    overrides[entry.name] = `file:${portable(root, file)}`;
  }
  for (const direct of closure.direct) {
    if (!overrides[direct.name]) continue;
    const key = portable(root, direct.manifestPath);
    const fromManifest = portable(dirname(direct.manifestPath), closure.packages.find((entry) => entry.name === direct.name).tarballPath);
    (manifestChanges[key] ||= []).push({
      field: direct.field,
      name: direct.name,
      from: direct.spec,
      to: `file:${fromManifest}`,
    });
  }
  return { overrides, manifestChanges, output: portable(root, output) };
}

export function verifyClosure(manifestPath, installRoot) {
  const closure = json(manifestPath);
  const failures = [];
  const lockPath = resolve(installRoot, 'pnpm-lock.yaml');
  const lock = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : '';
  const virtualStore = resolve(installRoot, 'node_modules/.pnpm');
  for (const pkg of closure.packages) {
    const tarball = resolve(dirname(manifestPath), pkg.tarball);
    if (!existsSync(tarball) || sha256(tarball) !== pkg.sha256) failures.push(`${pkg.name}: tarball SHA-256 differs from closure manifest`);
    if (!existsSync(tarball) || sha512(tarball) !== pkg.sha512) failures.push(`${pkg.name}: tarball SHA-512 differs from closure manifest`);
    const installed = [resolve(installRoot, 'node_modules', pkg.name, 'package.json')];
    if (existsSync(virtualStore)) {
      for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
        if (entry.isDirectory()) installed.push(resolve(virtualStore, entry.name, 'node_modules', pkg.name, 'package.json'));
      }
    }
    const copies = installed.filter(existsSync);
    if (!copies.length) failures.push(`${pkg.name}: missing from node_modules and pnpm virtual store`);
    for (const path of copies) {
      const actual = json(path).version;
      if (actual !== pkg.version) failures.push(`${pkg.name}: ${portable(installRoot, path)} is ${actual}, expected ${pkg.version}`);
      const resolved = realpathSync(path);
      if (!resolved.startsWith(`${resolve(installRoot, 'node_modules')}${sep}`)) {
        failures.push(`${pkg.name}: ${portable(installRoot, path)} resolves outside this install root`);
      }
    }
    if (!lock.includes(pkg.resolution)) failures.push(`${pkg.name}: pnpm-lock.yaml does not resolve the expected ${pkg.resolution}`);
    if (!lock.includes(`integrity: sha512-${pkg.sha512}`)) failures.push(`${pkg.name}: pnpm-lock.yaml integrity does not match the expected SHA-512`);
  }
  if (failures.length) throw new Error(`Closure verification failed:\n${failures.map((x) => `- ${x}`).join('\n')}`);
  return closure.packages.length;
}

export function createClosure({ sourceRoots, seedManifestPaths, output, allowDirty = false, root = repositoryRoot }) {
  const absoluteSources = sourceRoots.map((path) => resolve(path));
  const identities = absoluteSources.map((source) => sourceIdentity(source, allowDirty));
  const closure = collectClosure(discoverPackages(absoluteSources), seedManifestPaths.map((path) => resolve(root, path)));
  const out = resolve(root, output);
  mkdirSync(out, { recursive: true });
  for (const entry of closure.packages) entry.tarballPath = pack(entry, out);
  const proposal = proposalFor(closure, out, root);
  const manifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    diagnosticDirtySourcesAllowed: allowDirty,
    sources: identities.map((identity) => ({ ...identity, path: portable(root, identity.path) })),
    packages: closure.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      source: portable(root, entry.directory),
      sourceCommit: identities.find((identity) => identity.path === entry.sourceRoot).commit,
      tarball: basename(entry.tarballPath),
      resolution: `file:${portable(root, entry.tarballPath)}`,
      sha256: sha256(entry.tarballPath),
      sha512: sha512(entry.tarballPath),
    })),
    edges: closure.edges,
    proposal,
  };
  writeFileSync(resolve(out, 'release-closure.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(resolve(out, 'pnpm-overrides.json'), `${JSON.stringify(proposal.overrides, null, 2)}\n`);
  writeFileSync(resolve(out, 'manifest-proposal.json'), `${JSON.stringify(proposal.manifestChanges, null, 2)}\n`);
  return manifest;
}

function help() {
  console.log('Usage: node scripts/agent-first-release-closure.mjs --source <repo> [--source <repo>] --seed <package.json> [--seed <package.json>] --output vendor/release');
  console.log('       node scripts/agent-first-release-closure.mjs --verify --manifest <release-closure.json> [--install-root <repo>]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) help();
    else if (args.verify) {
      if (!args.manifest) throw new Error('--verify requires --manifest');
      console.log(`Verified ${verifyClosure(resolve(repositoryRoot, args.manifest), resolve(repositoryRoot, args.installRoot || '.'))} installed local packages.`);
    } else {
      if (!args.source.length || !args.seed.length || !args.output) throw new Error('--source, --seed, and --output are required');
      const manifest = createClosure({ sourceRoots: args.source, seedManifestPaths: args.seed, output: args.output, allowDirty: args.allowDirty });
      console.log(`Packed ${manifest.packages.length} local packages into ${args.output}.`);
      console.log('Apply pnpm-overrides.json and manifest-proposal.json deliberately; this command does not edit manifests or lockfiles.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
