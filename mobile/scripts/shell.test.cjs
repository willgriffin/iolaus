const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig, parseOverride } = require('./shell-config.cjs');

test('release loads only the HTTPS cloud host and offline fallback', () => {
  const config = buildConfig();
  assert.equal(config.appId, 'us.jobgeni.app');
  assert.equal(config.server.url, 'https://jobgeni.us/admin/career/');
  assert.equal(config.ios.contentInset, 'always');
  assert.equal(config.loggingBehavior, 'none');
  assert.deepEqual(config.server.allowNavigation, ['jobgeni.us']);
  assert.equal(config.server.cleartext, undefined);
  assert.equal(config.server.errorPath, 'index.html');
  assert.ok(fs.existsSync(path.join(__dirname, '..', config.webDir, 'index.html')));
});

test('explicit development override is bounded to an origin', () => {
  for (const origin of ['http://localhost:5173', 'http://192.168.1.5:5173', 'https://staging.example.test']) {
    const config = buildConfig({ JOBGENI_MOBILE_SERVER_URL: origin });
    assert.equal(config.server.url, origin);
    assert.ok(config.server.allowNavigation.includes(new URL(origin).hostname));
    assert.equal(Boolean(config.server.cleartext), origin.startsWith('http:'));
  }
  for (const value of ['not-a-url', 'file:///tmp', 'http://public.example.com', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/?token=secret', 'https://example.test/#fragment']) {
    assert.throws(() => parseOverride(value));
  }
});

test('shell has no private storage, AI or billing plugins', () => {
  const pkg = require('../package.json');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@capacitor/android', '@capacitor/core', '@capacitor/ios']);
});
