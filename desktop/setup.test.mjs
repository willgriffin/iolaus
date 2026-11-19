import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'apps/site');
const entry = pathToFileURL(join(root, 'desktop/setup.ts')).href;
const sqlEntry = import.meta.resolve('@happyvertical/sql');
const stagedManifest = process.env.IOLAUS_NATIVE_TEST_MANIFEST || join(root, '.desktop/stage/apps/site/manifest.json');

// Real staged native model metadata, empty isolated data root, supplied secure
// SQLite executor. Positive: setup/read/restart. Negative: incomplete schema
// rolls back; manifest escapes refused. No HTTP, providers, containers or PII.
async function fixture(run, broken = false) {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'iolaus-native-setup-')));
  const sourceRoot = join(work, 'app');
  const dataDirectory = join(work, 'data');
  await mkdir(join(sourceRoot, 'apps/site'), { recursive: true });
  await writeFile(join(sourceRoot, 'package.json'), JSON.stringify({ name: 'native-setup-fixture', type: 'module' }));
  await writeFile(join(sourceRoot, 'apps/site/smrt.config.js'), "export default { runtime: {profile:'local'}, smrt: {tableNames: {'@happyvertical/smrt-messages:Attachment': 'message_attachments'}} };\n");
  const manifest = JSON.parse(await readFile(stagedManifest, 'utf8'));
  if (broken) {
    let removed = 0;
    for (const [key, value] of Object.entries(manifest.objects)) if (value.schema?.tableName === 'skill_terms') { delete manifest.objects[key]; removed++; }
    assert.equal(removed, 1, 'Failure fixture must remove the actual native matching input schema.');
  }
  const manifestPath = join(sourceRoot, 'apps/site/manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  try { await run({ work, sourceRoot, dataDirectory, manifestPath }); }
  finally { await rm(work, { recursive: true, force: true }); }
}
async function probe(options, body) {
  const script = join(options.work, 'probe.mjs');
  const code = `const {prepareNativeInstallation}=await import(${JSON.stringify(entry)}); const options=${JSON.stringify({ appId: 'native-setup-fixture', bindHost: '127.0.0.1', ...options })}; ${body}`.replaceAll("import('@happyvertical/sql')", `import(${JSON.stringify(sqlEntry)})`);
  await writeFile(script, code);
  const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', script], {
    cwd: site, env: { ...process.env, SMRT_APP_ID: 'native-setup-fixture', SMRT_RUNTIME_PROFILE: 'local', SMRT_DATA_DIR: options.dataDirectory, TSX_TSCONFIG_PATH: join(site, 'tsconfig.runtime.json') }, maxBuffer: 2_000_000,
  });
  assert.doesNotMatch(stderr, /HV_SQL_SQLITE_ENGINE_MIX|SQLITE_CORRUPT/u);
  return stdout;
}

test('fresh native setup installs projections atomically, is idempotent and persists after restart', { timeout: 60_000 }, async () => fixture(async (options) => {
  const result = await probe(options, `
    const first=await prepareNativeInstallation(options);
    const {getDatabase}=await import('@happyvertical/sql');
    const dbOptions={type:'sqlite',url:options.dataDirectory+'/application.sqlite',cache:false,secureFile:{driver:'node:sqlite',custody:'trusted-parent',root:options.dataDirectory}};
    let db=await getDatabase(dbOptions);
    if((await db.query('SELECT COUNT(*) AS n FROM opportunities')).rows[0].n!==0) throw Error('Native catalog not empty');
    if((await db.query('SELECT COUNT(*) AS n FROM matching_results')).rows[0].n!==0) throw Error('Projection read failed');
    await db.query("UPDATE matching_worker_cursor SET source_cursor='synthetic-progress' WHERE id=1");
    await db.close();
    const second=await prepareNativeInstallation(options);
    db=await getDatabase(dbOptions);
    if((await db.query('SELECT source_cursor FROM matching_worker_cursor WHERE id=1')).rows[0].source_cursor!=='synthetic-progress') throw Error('Restart lost state');
    await db.close();
    console.log(JSON.stringify({nativeSetupProof:true,first,second}));
  `);
  assert.match(result, /"nativeSetupProof":true/u);
  assert.match(result, /"first":\{"status":"ready","firstRun":true\}/u);
  assert.match(result, /"second":\{"status":"ready","firstRun":false\}/u);
}));

test('incomplete staged schema rolls first-run native installation back without retaining a database', { timeout: 60_000 }, async () => fixture(async (options) => {
  const result = await probe(options, `
    const {existsSync}=await import('node:fs');
    let failed=false;
    try { await prepareNativeInstallation(options); } catch { failed=true; }
    if(!failed || existsSync(options.dataDirectory+'/application.sqlite')) throw Error('First-run failure retained a partial database');
    console.log('nativeRollbackProof');
  `);
  assert.match(result, /nativeRollbackProof/u);
}, true));

test('refuses a manifest outside the packaged application before opening a database', async () => fixture(async (options) => {
  const outside = join(options.work, 'outside.json');
  await writeFile(outside, await readFile(options.manifestPath));
  const result = await probe({ ...options, manifestPath: outside }, `
    let refused=false;
    try { await prepareNativeInstallation(options); } catch(error) { refused=error.message.includes('inside the packaged application'); }
    if(!refused) throw Error('Escaped manifest accepted');
    console.log('nativeContainmentProof');
  `);
  assert.match(result, /nativeContainmentProof/u);
  await rm(options.manifestPath);
  await symlink(outside, options.manifestPath);
  const linked = await probe(options, `
    let refused=false;
    try { await prepareNativeInstallation(options); } catch(error) { refused=error.message.includes('inside the packaged application'); }
    if(!refused) throw Error('Symlinked manifest escape accepted');
    console.log('nativeContainmentProof');
  `);
  assert.match(linked, /nativeContainmentProof/u);
}));
