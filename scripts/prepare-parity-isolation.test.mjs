import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = fileURLToPath(
  new URL('./ci/prepare-parity-isolation.sh', import.meta.url),
);

const fixtureSource = String.raw`
function /usr/bin/unshare() {
  printf 'unshare %s\n' "$*" >>"$TEST_TRACE"
  count="$(cat "$TEST_COUNT" 2>/dev/null || printf '0')"
  count=$((count + 1))
  printf '%s\n' "$count" >"$TEST_COUNT"
  case "$TEST_MODE" in
    always-success) return 0 ;;
    always-denied) return 42 ;;
    first-denied-then-success)
      [ "$count" -gt 1 ]
      ;;
    reprobe-fails)
      [ "$count" -gt 1 ] && return 42 || return 1
      ;;
    *) return 99 ;;
  esac
}

sudo() {
  printf 'sudo %s\n' "$*" >>"$TEST_TRACE"
  [ "$1" = apparmor_parser ] && [ "$2" = -r ] || return 90
  [ "$TEST_PARSER_MODE" = fail ] && return 17
  cp -- "$3" "$TEST_CAPTURE"
}
`;

function createFixture({ mode, parserMode = 'success' }) {
  const directory = mkdtempSync(join(tmpdir(), 'iolaus-parity-isolation-'));
  const env = {
    ...process.env,
    BASH_ENV: join(directory, 'fixture.bash'),
    TEST_CAPTURE: join(directory, 'profile.capture'),
    TEST_COUNT: join(directory, 'unshare.count'),
    TEST_MODE: mode,
    TEST_PARSER_MODE: parserMode,
    TEST_TRACE: join(directory, 'trace.log'),
  };
  writeFileSync(env.BASH_ENV, fixtureSource);
  writeFileSync(env.TEST_COUNT, '0');
  writeFileSync(env.TEST_TRACE, '');
  return { directory, env };
}

function runHelper(fixture) {
  return spawnSync(helper, [], {
    env: fixture.env,
    encoding: 'utf8',
  });
}

function readTrace(fixture) {
  return readFileSync(fixture.env.TEST_TRACE, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

function profilePathFromTrace(fixture) {
  const parserLine = readTrace(fixture).find((line) =>
    line.startsWith('sudo apparmor_parser -r '),
  );
  assert.ok(parserLine, 'the profile parser should receive the temporary file');
  return parserLine.slice('sudo apparmor_parser -r '.length);
}

function removeFixture(fixture) {
  // The fixture directory contains only test-owned files; production cleanup
  // is tested through the temporary profile path.
  rmSync(fixture.directory, { force: true, recursive: true });
}

test('base preflight fails while the helper recovers the denied mapping', () => {
  const baselineFixture = createFixture({ mode: 'always-denied' });
  const helperFixture = createFixture({ mode: 'first-denied-then-success' });
  try {
    const baseline = spawnSync(
      '/bin/bash',
      ['-c', '/usr/bin/unshare --user --map-root-user --net -- true'],
      { env: baselineFixture.env, encoding: 'utf8' },
    );
    assert.equal(baseline.status, 42);

    const result = runHelper(helperFixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readTrace(helperFixture).filter((line) => line.startsWith('unshare ')).length,
      2,
    );
    assert.equal(
      readTrace(helperFixture).filter((line) => line.startsWith('sudo ')).length,
      1,
    );
  } finally {
    removeFixture(baselineFixture);
    removeFixture(helperFixture);
  }
});

test('supported user namespaces skip profile loading', () => {
  const fixture = createFixture({ mode: 'always-success' });
  try {
    const result = runHelper(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readTrace(fixture), ['unshare --user --map-root-user --net -- true']);
    assert.equal(existsSync(fixture.env.TEST_CAPTURE), false);
  } finally {
    removeFixture(fixture);
  }
});

test('loads the exact fixed profile and removes its temporary file', () => {
  const fixture = createFixture({ mode: 'first-denied-then-success' });
  try {
    const result = runHelper(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(fixture.env.TEST_CAPTURE, 'utf8'),
      'abi <abi/4.0>,\ninclude <tunables/global>\n\n' +
        'profile iolaus-parity-unshare /usr/bin/unshare flags=(unconfined) {\n' +
        '  userns,\n}\n',
    );
    assert.equal(existsSync(profilePathFromTrace(fixture)), false);
  } finally {
    removeFixture(fixture);
  }
});

test('parser failure stops before the reprobe and cleans up', () => {
  const fixture = createFixture({
    mode: 'first-denied-then-success',
    parserMode: 'fail',
  });
  try {
    const result = runHelper(fixture);
    assert.equal(result.status, 17);
    assert.equal(readTrace(fixture).filter((line) => line.startsWith('unshare ')).length, 1);
    assert.equal(existsSync(profilePathFromTrace(fixture)), false);
  } finally {
    removeFixture(fixture);
  }
});

test('a failed reprobe propagates its status and cleans up', () => {
  const fixture = createFixture({ mode: 'reprobe-fails' });
  try {
    const result = runHelper(fixture);
    assert.equal(result.status, 42);
    assert.equal(readTrace(fixture).filter((line) => line.startsWith('unshare ')).length, 2);
    assert.equal(existsSync(profilePathFromTrace(fixture)), false);
  } finally {
    removeFixture(fixture);
  }
});

test('repeated recovery invocations remain isolated and clean up', () => {
  const first = createFixture({ mode: 'first-denied-then-success' });
  const second = createFixture({ mode: 'first-denied-then-success' });
  try {
    assert.equal(runHelper(first).status, 0);
    assert.equal(runHelper(second).status, 0);
    assert.notEqual(profilePathFromTrace(first), profilePathFromTrace(second));
    assert.equal(existsSync(profilePathFromTrace(first)), false);
    assert.equal(existsSync(profilePathFromTrace(second)), false);
  } finally {
    removeFixture(first);
    removeFixture(second);
  }
});
