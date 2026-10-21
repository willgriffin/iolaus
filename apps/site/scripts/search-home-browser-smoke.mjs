import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.SEARCH_HOME_URL ?? 'http://127.0.0.1:5799';
const evidence = process.env.SEARCH_HOME_EVIDENCE_DIR ?? '/tmp/jobgenius-search-home/evidence/browser';
const executablePath = process.env.PUBLIC_SITE_CHROME;
if (!executablePath) throw new Error('PUBLIC_SITE_CHROME is required.');
mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const results = [], errors = [];
const preferenceKey = 'iolaus.search-discovery-preferences.v1';
function observe(page) { page.on('pageerror', error => errors.push(error.stack ?? error.message)); }
async function open(page, path = '/') {
  const response = await page.goto(`${base}${path}`);
  assert.equal(response.status(), 200);
  await page.waitForLoadState('networkidle');
}
async function overflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
async function ready(button) { await button.waitFor(); await button.page().waitForFunction(() => !document.querySelector('.actions button')?.disabled); }
try {
  for (const width of [320, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); observe(page);
    await open(page);
    assert.equal(await page.locator('input[type=search]').count(), 1);
    await page.getByRole('button', { name: 'Trades & construction', exact: true }).click();
    await page.getByRole('button', { name: 'Welding', exact: true }).click();
    await page.getByLabel('Location', { exact: false }).fill('Edmonton');
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: 'Trades & construction', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Welding', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByLabel('Location', { exact: false }).inputValue(), 'Edmonton');
    await page.getByRole('button', { name: 'Clear location', exact: true }).click();
    await page.getByRole('button', { name: 'Welding', exact: true }).click();
    await page.getByRole('searchbox').fill('remote welding');
    await page.getByRole('button', { name: 'Remove Welding', exact: true }).click();
    await page.getByRole('button', { name: 'Search opportunities', exact: true }).click();
    await page.waitForURL(url => url.pathname.startsWith('/opportunities'));
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).searchParams.get('skills_mode'), 'replace');
    assert.deepEqual(new URL(page.url()).searchParams.getAll('skills'), []);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await open(page, '/opportunities?search=Engineer&start=1');
    await page.locator('.opportunity-card').first().waitFor();
    const pass = page.getByRole('button', { name: 'Pass', exact: true });
    const firstTitle = await page.locator('.opportunity-card h2').innerText();
    await ready(pass); await pass.click();
    await page.waitForFunction(previous => document.querySelector('.opportunity-card h2')?.textContent !== previous, firstTitle);
    assert.equal(await page.locator('.progress').count(), 0);
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await page.locator('.result-list').waitFor();
    assert.ok(await page.locator('.result-list > li').count() > 1);
    for (const decision of ['Pass', 'Later', 'Save']) {
      const review = page.locator('.list-card .review').first();
      const id = await review.getAttribute('id');
      await review.click();
      await page.locator('.opportunity-card').waitFor();
      assert.equal(await page.getByRole('button', { name: 'List view', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(new URL(page.url()).searchParams.get('view'), 'list');
      await page.getByRole('button', { name: decision, exact: true }).click();
      await page.locator('.result-list').waitFor();
      assert.equal(await page.locator(`[id="${id}"]`).count(), 0);
      await page.getByRole('button', { name: 'Undo last choice', exact: true }).click();
      await page.locator(`[id="${id}"]`).waitFor();
    }
    const savedId = await page.locator('.list-card .review').first().getAttribute('id');
    await page.locator('.list-card').first().getByRole('button', { name: 'Love', exact: true }).click();
    await page.waitForFunction(id => !document.getElementById(id), savedId);
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.locator(`[id="${savedId}"]`).count(), 0);
    const count = await page.locator('.result-list > li').count();
    const more = page.getByRole('button', { name: 'Load more opportunities', exact: true });
    if (await more.count()) {
      await more.click();
      await page.waitForFunction(previous => document.querySelectorAll('.result-list > li').length > previous, count);
    }
    await overflow(page);
    await page.screenshot({ path: `${evidence}/list-${width}.png`, fullPage: true });
    await page.reload(); await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: 'List view', exact: true }).getAttribute('aria-pressed'), 'true');
    await open(page); await overflow(page);
    await page.screenshot({ path: `${evidence}/home-${width}.png`, fullPage: true });
    results.push({ check: 'remembered category, skill/location edit, derived-skill exclusion, full-page triage/list progress and decisions, pagination/reload, responsive layout', width });
    await context.close();
  }
  const geo = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 53.55, longitude: -113.49 } });
  const page = await geo.newPage(); observe(page);
  let geoRequests = 0;
  await page.route('**/api/public/v1/location?**', route => { geoRequests++; return route.fulfill({ json: { location: 'Edmonton' } }); });
  await open(page);
  await page.waitForFunction(() => document.querySelector('#search-location')?.value === 'Edmonton');
  assert.equal(geoRequests, 1);
  const stored = await page.evaluate(key => localStorage.getItem(key), preferenceKey);
  assert.ok(!stored.includes('latitude') && !stored.includes('longitude'));
  await page.getByLabel('Location', { exact: false }).fill('Calgary');
  await page.reload(); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByLabel('Location', { exact: false }).inputValue(), 'Calgary');
  assert.equal(geoRequests, 1, 'saved override prevents repeated lookup');
  await page.getByRole('button', { name: 'Clear location', exact: true }).click();
  await page.reload(); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByLabel('Location', { exact: false }).inputValue(), '');
  assert.equal(geoRequests, 1, 'explicit Anywhere remains cleared');
  const invalid = await geo.request.get(`${base}/api/public/v1/location?latitude=91&longitude=0`);
  assert.equal(invalid.status(), 400);
  assert.equal(invalid.headers()['cache-control'], 'no-store');
  results.push({ check: 'permission-granted browser location, manual override remembered, no coordinate persistence; provider response mocked' });
  await geo.close();

  const denied = await browser.newContext();
  await denied.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition(_success, fail) { fail({ code: 1 }); } } });
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const fallback = await denied.newPage(); observe(fallback); await open(fallback);
  await fallback.getByRole('button', { name: 'Use my location', exact: true }).click();
  await fallback.getByText('Location permission was not granted.', { exact: false }).waitFor();
  await fallback.getByRole('button', { name: 'Healthcare & care', exact: true }).click();
  await fallback.getByRole('button', { name: 'Patient care', exact: true }).click();
  await fallback.getByRole('button', { name: 'Search opportunities', exact: true }).click();
  await fallback.waitForURL(url => url.pathname.startsWith('/opportunities'));
  await fallback.waitForLoadState('networkidle');
  assert.equal(new URL(fallback.url()).searchParams.get('skills'), 'patient-care');
  results.push({ check: 'denied geolocation and blocked storage preserve manual skills-only search' });
  await denied.close();
  if (process.env.SEARCH_HOME_ACCOUNT_STATE) {
    const account = await browser.newContext({ storageState: process.env.SEARCH_HOME_ACCOUNT_STATE });
    const signed = await account.newPage(); observe(signed);
    await open(signed, '/opportunities?search=Engineer&start=1&view=list');
    const row = signed.locator('.list-card').first();
    const id = await row.locator('.review').getAttribute('id');
    await row.getByRole('button', { name: 'Love', exact: true }).click();
    await signed.waitForFunction(id => !document.getElementById(id), id);
    await signed.reload(); await signed.waitForLoadState('networkidle');
    assert.equal(await signed.locator(`[id="${id}"]`).count(), 0);
    assert.equal(await signed.evaluate(() => localStorage.getItem('iolaus:shortlist:v1')), null);
    results.push({ check: 'signed-in list decisions survive reload without guest storage (isolated fixture account)' });
    await account.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, evidence }));
} catch (error) {
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ results, errors, failure: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
