import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parseProductConfig } from '@happyvertical/smrt-desktop/bundler';
import { readFileSync } from 'node:fs';

for (const revision of ['', 'not-a-compiled-site-revision']) {
  test(`existing build requires explicit provenance (${revision || 'absent'})`, () => {
    const destination = mkdtempSync(join(tmpdir(), 'iolaus-native-inputs-'));
    try {
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/desktop.mjs'), 'bundle', '--use-existing-build'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            IOLAUS_DESKTOP_OUTPUT: destination,
            IOLAUS_DESKTOP_BUILD_REVISION: revision,
          },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /requires IOLAUS_DESKTOP_BUILD_REVISION/);
      assert.equal(existsSync(join(destination, 'stage')), false);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
}
test('public product config explicitly records guarded optional WASI fallback', () => {
  const config = parseProductConfig(
    readFileSync('desktop/smrt-desktop.json', 'utf8'),
  );
  assert.ok(
    config.acknowledgedDynamicImports.some(
      (item) =>
        item.from === '@napi-rs/canvas' && item.specifier === './skia.wasi.cjs',
    ),
  );
  assert.ok(config.features.default.includes('pdf'));
});
