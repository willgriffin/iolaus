import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.SEARCH_TRIAGE_URL;
const evidence = process.env.SEARCH_TRIAGE_EVIDENCE_DIR;
const executablePath = process.env.PUBLIC_SITE_CHROME;
const primaryStorageState = process.env.SEARCH_TRIAGE_PRIMARY_STORAGE_STATE;
const secondaryStorageState = process.env.SEARCH_TRIAGE_SECONDARY_STORAGE_STATE;
if (!base || !evidence || !executablePath)
  throw new Error('Set SEARCH_TRIAGE_URL, SEARCH_TRIAGE_EVIDENCE_DIR, and PUBLIC_SITE_CHROME.');

mkdirSync(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
// Keep the served smoke below the public API's 60-request/minute budget.
// This delays real requests rather than bypassing or mocking the limit.
let nextPublicRequest = 0;
async function newContext(options = {}) {
  nextPublicRequest = Date.now();
  const context = await browser.newContext(options);
  await context.route('**/api/public/v1/**', async route => {
    const scheduled = Math.max(Date.now(), nextPublicRequest);
    nextPublicRequest = scheduled + 1500;
    await new Promise(resolve => setTimeout(resolve, scheduled - Date.now()));
    await route.continue();
  });
  return context;
}
const results = [];
const errors = [];
let expectedPaginationFailure = false;
const query = 'Engineer';

function record(page, label) {
  page.on('pageerror', (error) => errors.push({ label, type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    // Chromium reports the active, deliberately route-mocked 503 as a console
    // error. Keep the exception scoped to that asserted failure phase.
    if (message.type() === 'error' && !(expectedPaginationFailure && label === 'pagination-and-empty' && message.text().includes('503')))
      errors.push({ label, type: 'console', message: message.text() });
  });
}

async function assertNoOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal overflow at ${await page.evaluate(() => innerWidth)}px`);
}

async function goto(page, path) {
  const response = await page.goto(new URL(path, base).toString());
  await page.waitForLoadState('domcontentloaded');
  assert.equal(response?.status(), 200, `${path} should serve successfully`);
}

async function search(page) {
  await goto(page, '/opportunities');
  await page.getByRole('searchbox').fill(query);
  await page.getByRole('button', { name: 'Search opportunities', exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/opportunities') && (url.searchParams.has('q') || url.searchParams.has('search')));
  assert.equal(await page.locator('.progress').count(), 0);
  await page.locator('.opportunity-card').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('search'), query);
  // The SSR card is visible before its triage controls hydrate; wait for the
  // client turn so a decision click cannot be lost during hydration.
  await page.waitForTimeout(750);
}

async function chooseAndApplySkill(page) {
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByRole('button', { name: 'Add skills', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Skill catalog', exact: true });
  await dialog.getByLabel('Find a skill', { exact: true }).fill('welding');
  const option = dialog.getByRole('checkbox').first();
  await option.waitFor();
  const name = await option.locator('xpath=..').innerText();
  await option.check();
  await dialog.getByRole('button', { name: 'Apply skills', exact: true }).click();
  const remove = page.getByRole('button', { name: /^Remove skill / });
  await remove.waitFor();
  await remove.click();
  assert.equal(await page.getByRole('button', { name: /^Remove skill / }).count(), 0, `skill ${name} should be removable before resubmitting`);
  results.push({ check: 'skill catalog add/remove', skill: name });
}

async function assertSafeExternalLink(link) {
  assert.match(await link.getAttribute('href') ?? '', /^https?:\/\//);
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
}

async function clickDecision(page, label) {
  const title = await page.locator('.opportunity-card h2 a').getAttribute('href');
  const button = page.getByRole('button', { name: label, exact: true });
  await button.waitFor({ state: 'visible' });
  assert.equal(await button.isDisabled(), false, `${label} must be enabled before deciding`);
  await button.click();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const next = await page.evaluate(() => ({
      title: document.querySelector('.opportunity-card h2 a')?.getAttribute('href') ?? null,
      ended: document.body.textContent?.includes('reached the end of these results') ?? false,
    }));
    if (next.ended) return;
    if (next.title !== title) {
      // Allow the active detail read to settle before another verdict.
      await page.waitForTimeout(1600);
      assert.equal(await button.isDisabled(), false, `${label} successor control must be enabled`);
      return;
    }
    await page.waitForTimeout(100);
  }
  const failure = await page.getByRole('alert').allTextContents();
  const progress = await page.locator('.progress').count();
  assert.fail(`${label} did not advance: url=${page.url()} title=${title} progress=${progress} disabled=${await button.isDisabled()} failure=${failure.join(' | ')}`);
}

async function guestFlow(width) {
  const context = await newContext({ viewport: { width, height: 844 } });
  const page = await context.newPage();
  record(page, `guest-${width}`);
  try {
    await search(page);
    await assertNoOverflow(page);
    await chooseAndApplySkill(page);
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await page.waitForLoadState('domcontentloaded');
    // A catalog filter is allowed to produce no results; restore a real served search for decisions.
    await search(page);

    const sourceLink = page.locator('.opportunity-card').first().getByRole('link', { name: /View original posting/ });
    await assertSafeExternalLink(sourceLink);
    await clickDecision(page, 'Pass');
    await clickDecision(page, 'Later');
    await clickDecision(page, 'Save');
    await page.getByRole('button', { name: 'Undo last choice', exact: true }).click();
    await goto(page, '/shortlist');
    await page.getByRole('button', { name: /^Saved \(/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^Saved \(/ }).isVisible(), true);
    await page.getByText('No saved opportunities yet.', { exact: false }).waitFor();
    await page.getByRole('button', { name: /^All shown \(/ }).click();
    assert.match(await page.getByRole('button', { name: /^All shown \(/ }).innerText(), /All shown/);
    // Restarting the same served query replays the first three cards; the third
    // is the explicit inverse target and must become saved again.
    await search(page);
    await clickDecision(page, 'Pass');
    await clickDecision(page, 'Later');
    await clickDecision(page, 'Save');
    await page.reload();
    await page.locator('.opportunity-card').waitFor();
    await assertNoOverflow(page);

    await goto(page, '/shortlist');
    await page.getByRole('button', { name: /^Saved \(/ }).waitFor();
    assert.equal(await page.getByText('No saved opportunities yet.', { exact: false }).count(), 0);
    await page.getByRole('button', { name: /^All shown \(/ }).click();
    const openPosting = page.getByRole('link', { name: /Open posting/ }).first();
    await assertSafeExternalLink(openPosting);
    const originalUrl = await openPosting.getAttribute('href');
    const email = page.getByRole('link', { name: 'Email this list to yourself', exact: true });
    const mailto = await email.getAttribute('href');
    assert.match(mailto ?? '', /^mailto:\?/);
    assert.match(decodeURIComponent(mailto ?? ''), /My opportunity shortlist/);
    assert.ok(decodeURIComponent(mailto ?? '').includes(originalUrl ?? ''), 'email draft must contain the safe original posting URL');
    assert.equal(page.context().pages().length, 1, 'email draft must not launch an external application during smoke');
    await page.evaluate(() => document.addEventListener('click', (event) => {
      const anchor = (event.target instanceof Element ? event.target.closest('a') : null);
      if (anchor?.textContent?.includes('Open posting')) event.preventDefault();
    }, { capture: true, once: true }));
    const beforeOpen = page.url();
    await openPosting.click();
    assert.equal(page.url(), beforeOpen, 'opened tracking must not navigate this smoke browser');
    await page.waitForTimeout(750);
    const opened = await page.evaluate((postingUrl) => JSON.parse(localStorage.getItem('iolaus:shortlist:v1') ?? '{"entries":[]}').entries.find((entry) => entry.opportunity.posting_url === postingUrl), originalUrl);
    assert.ok(opened?.openedAt, 'opening a posting must record openedAt');
    assert.equal(opened?.appliedAt, null, 'opening a posting must not mark it applied');
    await page.getByRole('button', { name: 'Mark applied', exact: true }).first().click();
    await page.waitForTimeout(750);
    const appliedId = await page.evaluate(() => JSON.parse(localStorage.getItem('iolaus:shortlist:v1') ?? '{"entries":[]}').entries.find((entry) => entry.appliedAt)?.opportunity.id);
    assert.ok(appliedId, 'manual Applied must record appliedAt');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: /^All shown \(/ }).click();
    const appliedRow = page.locator(`li:has(a[href="/opportunities/${appliedId}"])`);
    await appliedRow.getByRole('button', { name: 'Mark not applied', exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem('iolaus:shortlist:v1') ?? '{"entries":[]}').entries.find((entry) => entry.opportunity.id === id)?.appliedAt ?? null, appliedId), null, 'manual Applied reset must clear appliedAt');
    await page.screenshot({ path: `${evidence}/guest-shortlist-${width}.png`, fullPage: true });
    results.push({ width, check: 'guest decisions, undo, reload, shortlist views, applied state, safe outbound links, email draft' });
  } finally {
    await context.close();
  }
}

async function crossTabAndStorageFailure() {
  const context = await newContext({ viewport: { width: 1280, height: 844 } });
  const observer = await context.newPage();
  const writer = await context.newPage();
  record(observer, 'cross-tab-observer');
  record(writer, 'cross-tab-writer');
  try {
    await goto(observer, '/shortlist');
    await observer.getByText('No saved opportunities yet.', { exact: false }).waitFor();
    await search(writer);
    await writer.getByRole('button', { name: 'Save', exact: true }).click();
    await observer.getByRole('button', { name: /^Saved \(1\)/ }).waitFor();
    results.push({ check: 'guest cross-tab storage event' });
  } finally {
    await context.close();
  }

  const blocked = await newContext({ viewport: { width: 320, height: 844 } });
  await blocked.addInitScript(() => {
    const key = 'iolaus:shortlist:v1';
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value(name) { if (name === key) throw new DOMException('blocked', 'SecurityError'); return getItem.call(this, name); } });
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value(name, value) { if (name === key) throw new DOMException('blocked', 'SecurityError'); return setItem.call(this, name, value); } });
  });
  const page = await blocked.newPage();
  record(page, 'blocked-storage');
  try {
    await search(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /Shortlist .* browser|storage/i }).waitFor();
    await assertNoOverflow(page);
    results.push({ check: 'blocked localStorage warning and memory fallback' });
  } finally {
    await blocked.close();
  }
}

async function paginationErrorAndEmptyState() {
  const context = await newContext({ viewport: { width: 1280, height: 844 } });
  const page = await context.newPage();
  record(page, 'pagination-and-empty');
  try {
    await search(page);
    const next = page.getByRole('button', { name: 'Show next opportunity', exact: true });
    for (let index = 0; index < 25 && !await next.isVisible().catch(() => false); index += 1)
      await clickDecision(page, 'Pass');
    await next.waitFor();
    const nextRequest = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/public/v1/opportunities' && url.searchParams.has('cursor');
    });
    const responsePromise = page.waitForResponse(response => response.url().includes('/api/public/v1/opportunities?') && new URL(response.url()).searchParams.has('cursor'));
    await next.click();
    await nextRequest;
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    await page.locator('.opportunity-card').waitFor();
    for (let index = 0; index < 25 && !await next.isVisible().catch(() => false); index += 1)
      await clickDecision(page, 'Pass');
    await next.waitFor();
    await page.route('**/api/public/v1/opportunities?**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test failure' }) }));
    expectedPaginationFailure = true;
    await next.click();
    await page.getByRole('alert').filter({ hasText: /Could not load more opportunities \(503\)/ }).waitFor();
    expectedPaginationFailure = false;
    await page.unroute('**/api/public/v1/opportunities?**');
    await goto(page, '/opportunities?q=unfindable-search-triage-fixture-9a7d7d');
    await page.getByText('No opportunities match this search.', { exact: false }).waitFor();
    await assertNoOverflow(page);
    results.push({ check: 'served pagination error and empty state' });
  } finally {
    await context.close();
  }
}

async function authenticatedFlow() {
  if (!primaryStorageState || !secondaryStorageState) {
    results.push({ check: 'authenticated coverage skipped (storage-state fixtures not supplied)' });
    return;
  }
  const primary = await newContext({ storageState: primaryStorageState, viewport: { width: 1280, height: 844 } });
  const page = await primary.newPage();
  record(page, 'account-primary');
  try {
    await goto(page, '/shortlist');
    await search(page);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await goto(page, '/shortlist');
    await page.getByRole('button', { name: /^Saved \([1-9]/ }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('iolaus:shortlist:v1')), null, 'authenticated shortlist must not write guest storage');
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.getByRole('button', { name: /^Saved \([1-9]/ }).waitFor();
    await assertNoOverflow(page);
    await page.screenshot({ path: `${evidence}/account-shortlist-1280.png`, fullPage: true });
    results.push({ check: 'authenticated save and reload persist without guest storage' });
  } finally {
    await primary.close();
  }

  const denied = await newContext({ storageState: secondaryStorageState, viewport: { width: 1280, height: 844 } });
  const deniedPage = await denied.newPage();
  record(deniedPage, 'account-secondary-denied');
  try {
    await goto(deniedPage, '/shortlist');
    const response = await denied.request.get(new URL('/api/shortlist', base).toString());
    assert.equal(response.status(), 403);
    await deniedPage.getByRole('link', { name: /Sign in/ }).first().waitFor();
    results.push({ check: 'uninvited identity is denied shortlist API while guest UI remains usable' });
  } finally {
    await denied.close();
  }
}

try {
  if (!process.env.SEARCH_TRIAGE_SCENARIO || process.env.SEARCH_TRIAGE_SCENARIO === 'guest') {
    await guestFlow(320);
    await guestFlow(1280);
    await crossTabAndStorageFailure();
  }
  if (!process.env.SEARCH_TRIAGE_SCENARIO || process.env.SEARCH_TRIAGE_SCENARIO === 'pagination') await paginationErrorAndEmptyState();
  if (!process.env.SEARCH_TRIAGE_SCENARIO || process.env.SEARCH_TRIAGE_SCENARIO === 'account') await authenticatedFlow();
  assert.deepEqual(errors, [], `browser errors: ${JSON.stringify(errors)}`);
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ base, results, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, evidence }));
} catch (error) {
  writeFileSync(`${evidence}/results.json`, JSON.stringify({ base, results, errors, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  throw error;
} finally {
  await browser.close();
}
