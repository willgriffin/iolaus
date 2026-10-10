import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getPDFReader } from '@happyvertical/pdf';
import { chromium } from 'playwright-core';

const base = process.env.PUBLIC_PROFILE_URL;
const evidence = process.env.PUBLIC_PROFILE_EVIDENCE_DIR;
const storageState = process.env.PUBLIC_PROFILE_STORAGE_STATE;
const foreignStorageState = process.env.PUBLIC_PROFILE_FOREIGN_STORAGE_STATE;
const chrome = process.env.PUBLIC_SITE_CHROME;
const fixturePath = process.env.PUBLIC_PROFILE_FIXTURE;
if (!base || !evidence || !storageState || !foreignStorageState || !chrome || !fixturePath)
  throw new Error('Set PUBLIC_PROFILE_URL, PUBLIC_PROFILE_EVIDENCE_DIR, PUBLIC_PROFILE_STORAGE_STATE, PUBLIC_PROFILE_FOREIGN_STORAGE_STATE, PUBLIC_PROFILE_FIXTURE, and PUBLIC_SITE_CHROME.');

mkdirSync(evidence, { recursive: true });
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const handle = String(fixture.handle ?? 'avery-fixture-profile');
const results = [];
const errors = [];
let activePage = null;
let phase = 'startup';
let finalPublication = null;
const browser = await chromium.launch({ executablePath: chrome, headless: true });

function observe(page, label) {
  page.on('pageerror', error => errors.push({ label, type: 'pageerror', message: error.message }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ label, type: 'console', message: message.text() }); });
}
async function noOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${await page.evaluate(() => innerWidth)}px`);
}
async function responseStatus(path, expected) {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, expected, `${path} status`);
  return response;
}
async function ownerFlow(width) {
  const context = await browser.newContext({ storageState, viewport: { width, height: 844 } });
  const page = await context.newPage();
  activePage = page;
  observe(page, `owner-${width}`);
  try {
    phase = `owner manager ${width}`;
    const manager = await page.goto(new URL('/admin/career/public-profile', base).toString());
    await page.waitForLoadState('networkidle');
    assert.equal(manager?.status(), 200);
    const form = page.locator('form.settings');
    await form.waitFor();
    for (const label of ['Email', 'Phone', 'Location', 'External links'])
      assert.equal(await form.getByLabel(label, { exact: true }).isChecked(), false, `${label} defaults off`);
    await noOverflow(page);
    const handleInput = form.getByLabel('Public handle', { exact: true });
    const existingHandle = await handleInput.inputValue();
    if (await handleInput.isEditable()) await handleInput.fill(handle);
    else assert.equal(existingHandle, handle, 'the fixture must retain its reserved immutable handle');
    phase = `owner prepare ${width}`;
    await form.getByRole('button', { name: 'Generate preview', exact: true }).click();
    await page.waitForURL(/\/admin\/career\/public-profile\/preview\/[0-9a-f-]{36}\/?$/);
    await page.waitForLoadState('networkidle');
    const previewPath = new URL(page.url()).pathname;
    const previewPdf = await page.getByRole('link', { name: 'Open matching PDF', exact: true }).getAttribute('href');
    assert.ok(previewPdf?.includes('/resume.pdf'));
    const previewPdfResponse = await context.request.get(new URL(previewPdf, base).toString());
    assert.equal(previewPdfResponse.status(), 200);
    assert.equal((await previewPdfResponse.body()).subarray(0, 5).toString(), '%PDF-');
    await page.getByRole('button', { name: 'Publish this version', exact: true }).focus();
    assert.equal(await page.getByRole('button', { name: 'Publish this version', exact: true }).evaluate(node => node === document.activeElement), true);
    phase = `owner publish ${width}`;
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/admin\/career\/public-profile\/?\?published=1$/);
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: resolve(evidence, `owner-published-${width}.png`), fullPage: true });
    results.push({ width, check: 'owner default-off controls, exact preview HTML/PDF, keyboard publish' });
    return { previewPath };
  } finally { await context.close(); }
}

try {
  const first = await ownerFlow(1280);
  phase = 'anonymous published profile';
  const publicPath = `/people/${encodeURIComponent(handle)}`;
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const publicPage = await anonymous.newPage();
  observe(publicPage, 'anonymous-public');
  const published = await publicPage.goto(new URL(publicPath, base).toString());
  await publicPage.waitForLoadState('networkidle');
  assert.equal(published?.status(), 200);
  const publishedText = await publicPage.locator('body').innerText();
  const publishedHtml = await publicPage.content();
  const publishedRevision = publishedHtml.match(/revisionId:\\?"([0-9a-f-]{36})/i)?.[1] ?? null;
  assert.ok(publishedRevision, 'published page must identify a served revision');
  assert.match(publishedText, /Fictional Health Care Aide/i);
  const publicPdf = await responseStatus(`${publicPath}/resume.pdf`, 200);
  assert.equal((await publicPdf.arrayBuffer()).byteLength > 5, true);
  assert.equal(Buffer.from(await (await fetch(new URL(`${publicPath}/resume.pdf`, base))).arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  await publicPage.screenshot({ path: resolve(evidence, 'public-1280.png'), fullPage: true });
  await noOverflow(publicPage);
  await publicPage.setViewportSize({ width: 320, height: 844 });
  await publicPage.reload({ waitUntil: 'networkidle' });
  await noOverflow(publicPage);
  await publicPage.getByRole('link', { name: 'Download resume as PDF', exact: true }).focus();
  assert.equal(await publicPage.getByRole('link', { name: 'Download resume as PDF', exact: true }).evaluate(node => node === document.activeElement), true);
  await publicPage.screenshot({ path: resolve(evidence, 'public-320.png'), fullPage: true });
  results.push({ check: 'anonymous published HTML/PDF, responsive layouts, keyboard focus' });
  await anonymous.close();

  // This is a one-purpose fixture-only mutation, guarded by its own exact local
  // database identity. It proves publication serves the captured snapshot.
  const fixtureRoot = resolve(fixturePath, '..');
  const mutator = process.env.PUBLIC_PROFILE_PRIVATE_MUTATOR ?? resolve(fixtureRoot, 'update-private.mts');
  const runtimeRoot = resolve(fixtureRoot, '..', '..');
  phase = 'native private fixture edit';
  execFileSync(process.execPath, [resolve(runtimeRoot, 'shared/run.mjs'), 'pnpm', 'exec', 'tsx', mutator], { cwd: process.env.IOLAUS_ROOT ?? process.cwd(), stdio: 'pipe', env: process.env });
  const immutableCheck = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const immutablePage = await immutableCheck.newPage();
  await immutablePage.goto(new URL(publicPath, base).toString(), { waitUntil: 'networkidle' });
  assert.equal(await immutablePage.locator('body').innerText(), publishedText, 'native private edit must not alter served public snapshot');
  const unchangedHtml = await immutablePage.content();
  assert.equal(unchangedHtml.match(/revisionId:\\?"([0-9a-f-]{36})/i)?.[1] ?? null, publishedRevision, 'private edit must retain the same published revision');
  await immutableCheck.close();

  const updateContext = await browser.newContext({ storageState, viewport: { width: 1280, height: 844 } });
  const update = await updateContext.newPage();
  activePage = update;
  observe(update, 'owner-update');
  await update.goto(new URL('/admin/career/public-profile', base).toString(), { waitUntil: 'networkidle' });
  phase = 'owner prepare update';
  await update.locator('form.settings').getByRole('button', { name: 'Generate preview', exact: true }).click();
  await update.waitForURL(/\/admin\/career\/public-profile\/preview\/[0-9a-f-]{36}\/?$/);
  assert.notEqual(new URL(update.url()).pathname, first.previewPath, 'new preparation must create a distinct immutable revision');
  await update.getByText('Private fixture edit after publication. The published profile must retain its earlier exact snapshot.', { exact: true }).waitFor();
  const preparedCheck = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const preparedPage = await preparedCheck.newPage();
  await preparedPage.goto(new URL(publicPath, base).toString(), { waitUntil: 'networkidle' });
  assert.equal(await preparedPage.locator('body').innerText(), publishedText, 'prepared update must not change current public version');
  assert.equal((await preparedPage.content()).match(/revisionId:\\?"([0-9a-f-]{36})/i)?.[1] ?? null, publishedRevision, 'prepared update must retain the current served revision');
  await preparedCheck.close();
  await update.getByRole('link', { name: 'Back to public profile settings', exact: true }).click();
  await update.waitForLoadState('networkidle');
  phase = 'owner unpublish';
  await update.getByRole('button', { name: 'Unpublish profile', exact: true }).click();
  await update.waitForURL(/\/admin\/career\/public-profile\/?\?unpublished=1$/);
  await updateContext.close();
  await responseStatus(publicPath, 404);
  await responseStatus(`${publicPath}/resume.pdf`, 404);
  results.push({ check: 'private native fixture edit leaves public version unchanged; update revision; unpublish withdraws HTML and PDF' });

  phase = 'final synthetic republish';
  const finalContext = await browser.newContext({ storageState, viewport: { width: 1280, height: 844 } });
  const finalPage = await finalContext.newPage();
  activePage = finalPage;
  observe(finalPage, 'owner-final-republish');
  await finalPage.goto(new URL('/admin/career/public-profile', base).toString(), { waitUntil: 'networkidle' });
  await finalPage.locator('form.settings').getByRole('button', { name: 'Generate preview', exact: true }).click();
  await finalPage.waitForURL(/\/admin\/career\/public-profile\/preview\/[0-9a-f-]{36}\/?$/);
  const finalPreviewPdf = await finalPage.getByRole('link', { name: 'Open matching PDF', exact: true }).getAttribute('href');
  const finalPdfBytes = await (await finalContext.request.get(new URL(finalPreviewPdf, base).toString())).body();
  assert.equal(finalPdfBytes.subarray(0, 5).toString(), '%PDF-');
  writeFileSync(resolve(evidence, 'public-resume.pdf'), finalPdfBytes);
  const pdfText = await (await getPDFReader({ provider: 'unpdf' })).extractText(finalPdfBytes, { skipOCRFallback: true });
  assert.ok(pdfText, 'public resume PDF must contain extractable text');
  assert.ok(pdfText.includes('Avery Fixture'));
  assert.ok(pdfText.includes('Fictional Health Care Aide and Welding Apprentice'));
  assert.ok(pdfText.includes('Private fixture edit after publication. The published profile must retain its earlier exact snapshot.'));
  assert.equal(pdfText.includes('public-profile-fixture@example.invalid'), false, 'disabled email contact must not reach public PDF');
  const finalPreviewId = new URL(finalPage.url()).pathname.split('/').filter(Boolean).at(-1);
  await finalPage.getByRole('button', { name: 'Publish this version', exact: true }).click();
  await finalPage.waitForURL(/\/admin\/career\/public-profile\/?\?published=1$/);
  await responseStatus(publicPath, 200);
  finalPublication = { handle, previewId: finalPreviewId, pdfSha256: createHash('sha256').update(finalPdfBytes).digest('hex') };
  await finalContext.close();
  results.push({ check: 'final synthetic republish, PDF text parity, and default-off email exclusion for cold-restart proof', ...finalPublication });

  const denied = await browser.newContext({ viewport: { width: 1280, height: 844 } });
  const deniedPage = await denied.newPage();
  observe(deniedPage, 'anonymous-denials');
  const guestPreview = await deniedPage.goto(new URL(first.previewPath, base).toString());
  assert.ok([302, 303, 401, 403, 404].includes(guestPreview?.status() ?? 0) || !deniedPage.url().includes(first.previewPath), 'anonymous preview must be denied');
  await responseStatus('/people/admin', 404);
  await responseStatus('/people/not-a-real-profile', 404);
  await denied.close();
  const foreign = await browser.newContext({ storageState: foreignStorageState, viewport: { width: 1280, height: 844 } });
  const foreignPage = await foreign.newPage();
  observe(foreignPage, 'foreign-preview');
  const foreignPreview = await foreignPage.goto(new URL(first.previewPath, base).toString());
  assert.ok([401, 403, 404].includes(foreignPreview?.status() ?? 0) || !foreignPage.url().includes(first.previewPath), 'foreign user must not read owner preview');
  await foreign.close();
  results.push({ check: 'anonymous and foreign preview plus invalid/reserved handle denials' });
  assert.deepEqual(errors, []);
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, evidence, finalPublication }));
} catch (error) {
  const alerts = activePage ? await activePage.getByRole('alert').allTextContents().catch(() => []) : [];
  const failure = { phase, pageUrl: activePage?.url() ?? null, alerts, message: error instanceof Error ? error.message : String(error) };
  if (activePage) await activePage.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => undefined);
  writeFileSync(resolve(evidence, 'results.json'), JSON.stringify({ results, errors, failure }, null, 2));
  console.error(JSON.stringify({ failure }));
  process.exitCode = 1;
} finally { await browser.close(); }
