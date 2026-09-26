#!/usr/bin/env node
// Fail when a git-tracked .npmrc carries registry credentials (#98).
//
// apps/site/Dockerfile copies the root .npmrc into the image so pnpm can
// resolve the @happyvertical scope, so anything in that file ships in every
// image layer. Registry credentials must reach the build through a BuildKit
// secret mount (RUN --mount=type=secret,...), never through a committed file.
// Even `${ENV}` placeholders are refused: keep auth out of the copied file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_KEY =
  /(?:^|:)(?:_authToken|_auth|_password|password|username|email|certfile|keyfile|cert|key)$/iu;

/** Report `{ line, key }` for every credential-bearing entry; never values. */
export function findNpmrcCredentials(text) {
  const findings = [];
  text.split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) return;
    const separator = line.indexOf('=');
    if (separator === -1) return;
    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^["']|["']$/gu, '');
    if (CREDENTIAL_KEY.test(key)) {
      findings.push({ key: key.replace(/^.*:/u, ''), line: index + 1 });
    }
  });
  return findings;
}

function trackedNpmrcFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--', '.npmrc', '**/.npmrc'],
    { encoding: 'utf8' },
  );
  return output.split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = trackedNpmrcFiles().flatMap((file) =>
    findNpmrcCredentials(readFileSync(file, 'utf8')).map(
      ({ key, line }) => `${file}:${line} sets ${key}`,
    ),
  );
  if (failures.length > 0) {
    console.error(
      'Committed .npmrc files must not carry registry credentials; they are ' +
        'copied into the site image. Pass credentials with a BuildKit secret ' +
        'mount instead.\n' +
        failures.map((failure) => `  ${failure}`).join('\n'),
    );
    process.exit(1);
  }
}
