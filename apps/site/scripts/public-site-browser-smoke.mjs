import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const base = process.env.PUBLIC_SITE_URL;
const evidence = process.env.PUBLIC_SITE_EVIDENCE_DIR;
if (!base || !evidence || !process.env.PUBLIC_SITE_FIXTURE) throw new Error('Set PUBLIC_SITE_URL, PUBLIC_SITE_EVIDENCE_DIR and PUBLIC_SITE_FIXTURE (JSON with ids and companyId).');
const fixture = JSON.parse(readFileSync(process.env.PUBLIC_SITE_FIXTURE, 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.PUBLIC_SITE_CHROME, headless: true });
const errors = [], results = [];
try {
  for (const width of [320, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    for (const path of ['/', '/opportunities/', `/opportunities/${fixture.ids[0]}/`, `/companies/${fixture.companyId}/`]) {
      const response = await page.goto(base + path);
      await page.waitForLoadState('networkidle');
      assert.equal(response.status(), 200);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal((await page.locator('body').innerText()).includes('PRIVATE_OVERLAY_NEVER_PUBLIC'), false);
      if (path === '/' || path === '/opportunities/') {
        assert.equal(await page.getByRole('searchbox').count(), 1);
        assert.equal(await page.locator('input:not([type]), input[type=text]').count(), 0);
        assert.equal(await page.getByRole('heading', { name: 'Match your skills' }).count(), 0);
      }
      const cards = page.locator('.opportunity-card');
      if (await cards.count()) {
        const card = cards.first();
        const external = card.getByRole('link', { name: 'View original posting', exact: false });
        assert.match(await external.getAttribute('href'), /^https?:\/\//);
        assert.equal(await external.getAttribute('target'), '_blank');
        assert.equal(await external.getAttribute('rel'), 'noopener noreferrer');
        assert.ok(await card.locator('dl dd').count() > 0);
        assert.equal(await card.getByRole('link', { name: 'View details', exact: true }).count(), 1);
        assert.equal((await card.innerText()).includes('unknown'), false);
      }
      if (path === '/opportunities/') await page.screenshot({ path: `${evidence}/cards-${width}.png`, fullPage: false });
      results.push({ width, path, status: response.status() });
    }
    await page.goto(base + '/');
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Add skills', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Skill catalog' });
    await modal.getByLabel('Category', { exact: true }).selectOption('care');
    await modal.getByLabel('Find a skill', { exact: true }).fill('patient');
    await modal.getByRole('checkbox', { name: 'Patient care', exact: false }).check();
    assert.equal(await modal.getByRole('checkbox', { name: 'Welding', exact: false }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await modal.isVisible(), false);
    assert.equal(await page.locator('.skill-chip').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add skills', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole('button', { name: 'Add skills', exact: true }).click();
    await modal.getByLabel('Category', { exact: true }).selectOption('trades');
    await modal.getByLabel('Find a skill', { exact: true }).fill('welding');
    await modal.getByRole('checkbox', { name: 'Welding', exact: false }).check();
    await modal.getByRole('button', { name: 'Apply skills' }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove skill Welding' }).count(), 1);
    await page.getByRole('button', { name: 'Add skills', exact: true }).click();
    await modal.getByLabel('Find a skill', { exact: true }).fill('nonesuch-unlisted-skill');
    await modal.getByText('No skills found.', { exact: false }).waitFor();
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Remove skill Welding' }).count(), 1);
    await page.getByRole('button', { name: 'Add skills', exact: true }).click();
    await modal.getByLabel('Category', { exact: true }).selectOption('care');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${evidence}/search-${width}.png`, fullPage: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(evidence + '/results.json', JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ checks: results.length, errors }));
} finally { await browser.close(); }
