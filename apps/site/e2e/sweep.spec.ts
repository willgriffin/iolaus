import { test as base, expect, type Page } from '@playwright/test';

const test = base.extend<{ localNetwork: undefined }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  baseURL: async ({}, use) => {
    const origin = process.env.IOLAUS_E2E_ORIGIN;
    if (!origin) throw new Error('E2E setup missing');
    await use(origin);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  storageState: async ({}, use) => {
    if (!process.env.IOLAUS_E2E_AUTH) throw new Error('E2E auth missing');
    await use(process.env.IOLAUS_E2E_AUTH);
  },
  localNetwork: [
    async ({ context, baseURL }, use) => {
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin === baseURL)
          return route.continue();
        return route.abort();
      });
      await use(undefined);
    },
    { auto: true },
  ],
});

function sweepTitles(project: string) {
  const prefix = `Fictional sweep ${project}`;
  return {
    active: `${prefix} active-source protected`,
    application: `${prefix} application-linked protected`,
    decided: `${prefix} decided protected`,
    eligible: `${prefix} eligible`,
    recent: `${prefix} recently-seen protected`,
  };
}

const sweepNotSeenDaysByProject: Record<string, number> = {
  'android-portrait': 120,
  'android-landscape': 90,
  'android-narrow': 60,
  'desktop-control': 30,
};

async function resultTotal(page: Page): Promise<number> {
  const text = await page.locator('body').innerText();
  const match = text.match(
    /\b\d+(?:-\d+)? of (\d+) (?:filtered|opportunities)\b/,
  );
  if (!match) throw new Error(`Opportunity total was not rendered: ${text}`);
  return Number(match[1]);
}

test('inactive-source sweep previews, protects rows, and refreshes the list after archival', async ({
  page,
}, testInfo) => {
  const titles = sweepTitles(testInfo.project.name);
  const notSeenDays = sweepNotSeenDaysByProject[testInfo.project.name];
  if (!notSeenDays)
    throw new Error(`Missing sweep cohort for ${testInfo.project.name}`);
  const response = await page.goto(
    '/admin/opportunities?review=unsorted&sort=best',
  );
  expect(response?.status()).toBe(200);

  for (const title of [
    titles.eligible,
    titles.active,
    titles.recent,
    titles.application,
  ]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  const before = await resultTotal(page);

  // A preview is intentionally read-only: the eligible fixture remains in the
  // rendered list until the explicit Archive confirmation is submitted.
  await page
    .locator(
      'form[aria-label="Inactive-source sweep"] input[name="notSeenDays"]',
    )
    .evaluate((input, value) => {
      (input as HTMLInputElement).value = String(value);
    }, notSeenDays);
  await page
    .getByRole('button', { name: 'Sweep inactive', exact: true })
    .click();
  const archive = page.getByRole('button', { name: /^Archive \d+$/ });
  await expect(archive).toBeVisible();
  const archivedCount = Number(
    (await archive.innerText()).replace('Archive ', ''),
  );
  expect(archivedCount).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(/Nothing was changed/i)).toBeVisible();
  await expect(page.getByText(titles.eligible, { exact: true })).toBeVisible();

  // This wait observes the authorized list read triggered by the client cache
  // invalidation, rather than a browser reload or a mocked response.
  const refreshedList = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'GET' &&
      new URL(candidate.url()).pathname ===
        '/api/admin-resources/opportunities' &&
      candidate.ok(),
  );
  await archive.click();
  await refreshedList;

  await expect(
    page.getByText(new RegExp(`Archived ${archivedCount} opportunit`, 'i')),
  ).toBeVisible();
  await expect(page.getByText(titles.eligible, { exact: true })).toHaveCount(0);
  for (const title of [titles.active, titles.recent, titles.application]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
  await expect.poll(() => resultTotal(page)).toBe(before - archivedCount);

  // Owner-decided rows are intentionally outside the Unsorted list. Confirm
  // the separate decision filter still returns the inactive-source fixture.
  await page.goto('/admin/opportunities?review=reject&sort=best');
  await expect(page.getByText(titles.decided, { exact: true })).toBeVisible();

  // Retrying the same mutation sees the post-archive state and does not offer
  // a second destructive confirmation.
  await page.goto('/admin/opportunities?review=unsorted&sort=best');
  await page
    .locator(
      'form[aria-label="Inactive-source sweep"] input[name="notSeenDays"]',
    )
    .evaluate((input, value) => {
      (input as HTMLInputElement).value = String(value);
    }, notSeenDays);
  await page
    .getByRole('button', { name: 'Sweep inactive', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /^Archive \d+$/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByText(/No opportunities under an? inactive source/i),
  ).toBeVisible();
});
