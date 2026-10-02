import { readFileSync } from 'node:fs';
import {
  test as base,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';

const test = base.extend<{ localNetwork: void }>({
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
      await use();
    },
    { auto: true },
  ],
});

async function openTasks(page: Page) {
  const response = await page.goto('/admin/tasks');
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Tasks', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Fictional mobile task 01', { exact: true }),
  ).toBeAttached();
}

async function swipe(
  page: Page,
  target: Locator,
  direction: 'up' | 'left',
  header = false,
) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('Swipe target has no bounds');
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Swipe needs a viewport');
  const right = Math.min(box.x + box.width, viewport.width);
  const bottom = Math.min(box.y + box.height, viewport.height);
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  expect(right - left).toBeGreaterThan(80);
  expect(bottom - top).toBeGreaterThan(80);
  const start = {
    x: left + (right - left) * 0.8,
    y: header ? top + 24 : top + (bottom - top) * 0.8,
  };
  const end =
    direction === 'up'
      ? { x: start.x, y: top + (bottom - top) * 0.2 }
      : { x: left + (right - left) * 0.2, y: start.y };
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [start],
    });
    for (let step = 1; step <= 12; step += 1) {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: start.x + ((end.x - start.x) * step) / 12,
            y: start.y + ((end.y - start.y) * step) / 12,
          },
        ],
      });
      // Pace physical input; assertions below poll the actual scroll result.
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
  // A tap during kinetic scrolling may only stop the scroll on touch devices.
  // Wait for three stable samples before the next interaction.
  let previous = '';
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const position = await target.evaluate(
          (element) => `${element.scrollLeft}:${element.scrollTop}`,
        );
        stableSamples = position === previous ? stableSamples + 1 : 0;
        previous = position;
        return stableSamples;
      },
      { intervals: [100], timeout: 5_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

test('authenticated admin routes render without application errors', async ({
  page,
}) => {
  for (const path of [
    '/admin/tasks',
    '/admin/opportunities',
    '/admin/applications',
    '/admin/sources',
  ]) {
    const resource = path.split('/').at(-1);
    const dataResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/admin-resources/${resource}`,
    );
    const response = await page.goto(path);
    expect((await dataResponse).status(), `${resource} data`).toBe(200);
    expect(response?.status(), path).toBe(200);
    await expect(page.locator('.admin-content')).toBeVisible();
    await expect(
      page.getByRole('link', { name: /employment search/i }),
    ).toBeVisible();
    await expect(page.locator('.resource-action-feedback.error')).toHaveCount(
      0,
    );
  }
});

test('archives orphan, approved, and in-progress applications through the dedicated cleanup action', async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-control',
    'The shared local fixture is mutated by this lifecycle scenario once.',
  );
  const fixturePath = process.env.IOLAUS_E2E_FIXTURE;
  if (!fixturePath) throw new Error('E2E cleanup fixture is missing');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    approvedApplicationId: string;
    draftingApplicationId: string;
    opportunityId: string;
    orphanApplicationId: string;
  };

  await page.goto('/admin/applications');

  const readRecord = async (resource: string, id: string) =>
    await page.evaluate(
      async ({ resource, id }) => {
        const response = await fetch(`/api/${resource}/${id}`);
        if (!response.ok) throw new Error(`Could not load ${resource}/${id}`);
        return await response.json();
      },
      { resource, id },
    );
  const approvedBefore = await readRecord(
    'applications',
    fixture.approvedApplicationId,
  );
  const opportunityBefore = await readRecord(
    'opportunities',
    fixture.opportunityId,
  );

  for (const id of [
    fixture.orphanApplicationId,
    fixture.approvedApplicationId,
    fixture.draftingApplicationId,
  ]) {
    await page.goto(`/admin/applications/${id}`);
    await expect(
      page.getByRole('button', { name: 'Archive application' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Archive application' }).click();
    await expect(page).toHaveURL(/\/admin\/applications\/?\?status=archived/);
  }

  await page.goto('/admin/applications');
  await expect(page.getByText('Untitled opportunity')).toHaveCount(0);
  await page.getByRole('link', { name: 'Archived', exact: true }).click();
  await expect(page.getByText('Untitled opportunity')).toBeVisible();

  const approvedAfter = await readRecord(
    'applications',
    fixture.approvedApplicationId,
  );
  expect(approvedAfter).toMatchObject({
    approvedAt: approvedBefore.approvedAt,
    approvedByUserId: approvedBefore.approvedByUserId,
    packetAssetId: approvedBefore.packetAssetId,
    resumeAssetId: approvedBefore.resumeAssetId,
    status: 'archived',
  });
  expect(await readRecord('opportunities', fixture.opportunityId)).toEqual(
    opportunityBefore,
  );

  await page.goto('/admin/tasks?status=canceled');
  for (const title of [
    'Fictional orphan cleanup task',
    'Fictional approved cleanup task',
    'Fictional drafting cleanup task',
  ]) {
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  }
});

test('navigation can be opened, used and reopened', async ({ page }) => {
  await openTasks(page);
  const panel = page.locator('.admin-tenant-panel');
  if ((page.viewportSize()?.width ?? 0) >= 1280) {
    await expect(panel).toBeInViewport();
    await panel
      .getByRole('button', { name: 'Collapse navigation', exact: true })
      .tap();
  }
  const opener = page
    .getByRole('button', { name: 'Expand navigation', exact: true })
    .first();
  await expect(opener).toBeInViewport();
  await opener.tap();
  await expect(panel).toBeInViewport();
  await panel.getByRole('link', { name: 'Opportunities', exact: true }).tap();
  await expect(page).toHaveURL(/\/admin\/opportunities/);
  if ((page.viewportSize()?.width ?? 0) <= 768) {
    await expect(opener).toBeInViewport();
    await opener.tap();
  }
  await panel
    .getByRole('button', { name: 'Collapse navigation', exact: true })
    .tap();
  await expect(opener).toBeInViewport();
});

test('task cards have usable height and respond to a vertical swipe', async ({
  page,
}) => {
  await openTasks(page);
  const list = page
    .getByRole('region', { name: 'Intake & Decisions', exact: true })
    .locator('.task-card-list');
  await expect(
    list.locator('.task-card').filter({ hasText: 'Fictional mobile task' }),
  ).toHaveCount(16);
  const height = await list.evaluate((element) => element.clientHeight);
  expect(height).toBeGreaterThanOrEqual(120);
  expect(
    await list.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await swipe(page, list, 'up');
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(30);
});

test('task board responds to a horizontal swipe across lane headers', async ({
  page,
}) => {
  await openTasks(page);
  const board = page.locator('.kanban-board');
  const height = await board.evaluate((element) => element.clientHeight);
  expect(height).toBeGreaterThan(80);
  await swipe(page, board, 'left', true);
  await expect
    .poll(() => board.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(30);
});

test('opportunity filters scroll vertically and close', async ({ page }) => {
  const response = await page.goto('/admin/opportunities');
  expect(response?.status()).toBe(200);
  await page.getByRole('button', { name: /^Filters/ }).tap();
  const dialog = page.getByRole('dialog', { name: 'Opportunity filters' });
  await expect(dialog).toBeVisible();
  const body = dialog.locator('.drawer-body');
  const overflows = await body.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  if (overflows) {
    await swipe(page, body, 'up');
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(30);
  } else {
    await expect(body.locator('.drawer-group').last()).toBeInViewport({
      ratio: 1,
    });
  }
  await dialog.getByRole('button', { name: 'Close filters' }).tap();
  await expect(dialog).toHaveCount(0);
});

test('eligibility bucket filters share the list query and survive a reload', async ({
  page,
}, testInfo) => {
  const prefix = `Eligibility ${testInfo.project.name}`;
  const params = new URLSearchParams({ q: prefix, review: 'unsorted' });
  params.append('eligibilityBucket', 'eligible');
  params.append('eligibilityBucket', 'sponsorship_possible');
  await page.goto(`/admin/opportunities?${params}`);

  await expect(
    page.getByText(`${prefix} Canada`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`${prefix} Conflict`, { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(`${prefix} Unknown`, { exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText(`${prefix} Canada`, { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.getAll('eligibilityBucket').join(',') ===
      'eligible,sponsorship_possible',
  );

  params.delete('eligibilityBucket');
  params.append('eligibilityBucket', 'unknown');
  await page.goto(`/admin/opportunities?${params}`);
  await expect(
    page.getByText(`${prefix} Unknown`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(`${prefix} Canada`, { exact: true })).toHaveCount(
    0,
  );
});

test('app settings use the full mobile width', async ({ page }) => {
  await openTasks(page);
  await page.getByRole('button', { name: 'Open app settings' }).tap();
  const drawer = page.locator('.smrt-admin-shell__drawer--top');
  await expect(drawer).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  const box = await drawer.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  if (width <= 768) {
    expect(box.x).toBeLessThanOrEqual(1);
    expect(box.x + box.width).toBeGreaterThanOrEqual(width - 1);
  } else {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  expect(
    await drawer.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test('application review actions fit inside the page', async ({ page }) => {
  await page.goto('/admin/applications');
  const review = page
    .locator('.application-list a[href^="/admin/applications/"]')
    .first();
  await expect(review).toBeVisible();
  await review.tap();
  await expect(page.locator('.review-header')).toBeVisible();
  const width = page.viewportSize()?.width ?? 0;
  const actions = await page.locator('.header-actions').boundingBox();
  expect(actions).not.toBeNull();
  if (!actions) return;
  expect(actions.x).toBeGreaterThanOrEqual(0);
  expect(actions.x + actions.width).toBeLessThanOrEqual(width);
});

test('filter controls fit without horizontal clipping', async ({ page }) => {
  await page.goto('/admin/opportunities');
  await page.getByRole('button', { name: /^Filters/ }).tap();
  const body = page
    .getByRole('dialog', { name: 'Opportunity filters' })
    .locator('.drawer-body');
  await expect(body).toBeVisible();
  const overflow = await body.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('application stage labels do not overlap', async ({ page }) => {
  await page.goto('/admin/applications');
  const labels = page
    .locator('.application-list .track')
    .first()
    .locator('.step-label');
  await expect(labels).toHaveCount(5);
  const boxes = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    }),
  );
  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1];
    const current = boxes[index];
    expect(
      current.left >= previous.right || current.top >= previous.bottom,
    ).toBe(true);
  }
});

test('footer status chips stay inside the visible footer', async ({ page }) => {
  await openTasks(page);
  const bar = page.locator('footer.smrt-admin-shell__edge--bottom');
  const chips = bar.locator('.smrt-system-status-chips');
  await expect(chips).toBeVisible();
  const outer = await bar.boundingBox();
  const inner = await chips.boundingBox();
  expect(outer).not.toBeNull();
  expect(inner).not.toBeNull();
  if (!outer || !inner) return;
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.y + inner.height).toBeLessThanOrEqual(
    Math.min(outer.y + outer.height, page.viewportSize()?.height ?? 0) + 1,
  );
});

test('horizontal swipes over lane content reach later lanes', async ({
  page,
}) => {
  await openTasks(page);
  const board = page.locator('.kanban-board');
  const height = await board.evaluate((element) => element.clientHeight);
  expect(height).toBeGreaterThan(80);
  await swipe(page, board, 'left');
  const offset = await board.evaluate((element) => element.scrollLeft);
  expect(offset).toBeGreaterThan(30);
});

test('navigation remains reachable after reload and viewport changes', async ({
  page,
}) => {
  await openTasks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page
    .locator('.admin-app-bar')
    .getByRole('button', { name: /navigation$/ });
  await expect(toggle).toBeInViewport();
  if ((await toggle.getAttribute('aria-expanded')) === 'true')
    await toggle.tap();
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.tap();
  await expect(page.locator('.admin-tenant-panel')).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(toggle).toBeInViewport();
  await page.setViewportSize({ width: 320, height: 568 });
  await expect(toggle).toBeInViewport();
  await expect(page.locator('.admin-tenant-panel')).toBeInViewport();
});

test('short task pages allow the toolbar to scroll out of the way', async ({
  page,
}) => {
  await openTasks(page);
  await page.setViewportSize({ width: 667, height: 375 });
  const main = page.locator('.smrt-admin-shell__main');
  expect(
    await main.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    ),
  ).toBeGreaterThan(30);
  const before = await main.evaluate((element) => element.scrollTop);
  await swipe(page, page.locator('.task-toolbar'), 'up');
  await expect
    .poll(() => main.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before + 30);
  await expect(page.locator('.kanban-board')).toBeInViewport();
});

test('triage uses the mobile viewport and keeps scrolling and actions reachable', async ({
  page,
}, testInfo) => {
  await page.goto(
    '/admin/opportunities?triage=1&sort=score&sortDirection=desc&q=Iolaus%20Triage',
  );
  const dialog = page.getByRole('dialog', { name: 'Triage opportunities' });
  await expect(dialog).toBeVisible();
  const card = dialog.locator('.triage-card');
  await expect(card).toBeVisible();
  const container = dialog.locator('.modal__container');
  const body = dialog.locator('.modal__body');
  await container.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await page.screenshot({ path: testInfo.outputPath('triage-top.png') });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Missing viewport');
  const box = await container.boundingBox();
  if (!box) throw new Error('Missing triage container');
  const mobile = testInfo.project.name !== 'desktop-control';
  if (mobile) {
    expect(box.x).toBeCloseTo(0, 0);
    expect(box.y).toBeCloseTo(0, 0);
    expect(box.width).toBeCloseTo(viewport.width, 0);
    expect(box.height).toBeCloseTo(viewport.height, 0);
    const mainStyle = await card.locator('.main').evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderLeftWidth, padding: style.paddingLeft };
    });
    expect(mainStyle).toEqual({ border: '0px', padding: '0px' });
  } else {
    expect(box.x).toBeGreaterThan(0);
    expect(box.y).toBeGreaterThan(0);
    expect(box.width).toBeLessThan(viewport.width);
  }
  expect(
    await body.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  const close = dialog.getByRole('button', { name: 'Close triage' });
  const later = dialog.getByRole('button', { name: 'Later', exact: true });
  for (const control of [
    close,
    later,
    dialog.getByRole('button', { name: 'Nope', exact: true }),
    dialog.getByRole('button', { name: 'Dig deeper', exact: true }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    if (mobile) expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  const originalCard = await card.getAttribute('aria-label');
  const before = await body.evaluate((element) => element.scrollTop);
  await swipe(page, body, 'up');
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before + 30);
  await expect(card).toHaveAttribute('aria-label', originalCard ?? '');
  await expect(close).toBeInViewport({ ratio: 1 });
  await expect(later).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('triage-scrolled.png') });
  await later.tap();
  await expect(card).not.toHaveAttribute('aria-label', originalCard ?? '');
  await close.tap();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Triage', exact: true }),
  ).toBeInViewport();
});

test('triage inherits list filters and ascending salary through refills and decisions', async ({
  page,
}, testInfo) => {
  const prefix = `Sequence ${testInfo.project.name}`;
  const projectIndex = [
    'android-portrait',
    'android-landscape',
    'android-narrow',
    'desktop-control',
  ].indexOf(testInfo.project.name);
  const salaryBase = 100_000 + projectIndex * 200_000;
  await page.addInitScript(() => {
    localStorage.setItem('iolaus.admin.triage.sort', 'newest');
  });
  const params = new URLSearchParams({
    q: prefix,
    status: 'found',
    salaryMin: String(salaryBase),
    salaryMax: String(salaryBase + 50_000),
    includeMissingComp: 'false',
    sort: 'salary',
    sortDirection: 'asc',
    review: 'unsorted',
  });
  await page.goto(`/admin/opportunities?${params}`);
  const titles = page.locator('.table-opportunity .title-link');
  const expected = Array.from(
    { length: 6 },
    (_, index) => `${prefix} Role ${index + 1}`,
  );
  await expect(titles).toHaveText(expected);
  await expect(page.getByLabel('Sort opportunities')).toHaveValue('salary');
  await page.getByRole('button', { name: 'Triage', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Triage opportunities' });
  const card = dialog.locator('.triage-card');
  await expect(dialog.getByRole('group', { name: 'Queue order' })).toHaveCount(
    0,
  );
  for (let index = 0; index < expected.length; index += 1) {
    await expect(card).toHaveAttribute(
      'aria-label',
      `Triage card for ${expected[index]}`,
    );
    const action = index === 1 ? 'Nope' : 'Later';
    const saved =
      index === 1
        ? page.waitForResponse(
            (response) =>
              response.request().method() === 'POST' &&
              response.url().includes('/reviewOpportunity') &&
              ![301, 302, 303, 307, 308].includes(response.status()),
          )
        : null;
    await dialog.getByRole('button', { name: action, exact: true }).click();
    if (saved) {
      const response = await saved;
      expect(response.ok(), await response.text()).toBe(true);
    }
  }
  await expect(card).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close triage' }).click();
  await expect(dialog).toBeHidden();
  await expect(titles).toHaveText(expected.filter((_, index) => index !== 1));
  await page.getByRole('button', { name: 'Triage', exact: true }).click();
  await expect(card).toHaveAttribute(
    'aria-label',
    `Triage card for ${expected[0]}`,
  );
  await dialog.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(card).toHaveAttribute(
    'aria-label',
    `Triage card for ${expected[2]}`,
  );
});

test('legacy triage sort links become list sorting and explicit list sort wins', async ({
  page,
}, testInfo) => {
  const params = new URLSearchParams({
    q: `Sequence ${testInfo.project.name}`,
    triage: '1',
    triageSort: 'newest',
  });
  await page.goto(`/admin/opportunities?${params}`);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('sort') === 'newest' &&
      !url.searchParams.has('triageSort'),
  );
  const dialog = page.getByRole('dialog', { name: 'Triage opportunities' });
  await expect(dialog.locator('.triage-card')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close triage' }).click();
  await expect(page.getByLabel('Sort opportunities')).toHaveValue('newest');
  params.set('sort', 'salary');
  params.set('sortDirection', 'asc');
  await page.goto(`/admin/opportunities?${params}`);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get('sort') === 'salary' &&
      url.searchParams.get('sortDirection') === 'asc' &&
      !url.searchParams.has('triageSort'),
  );
  await expect(dialog.locator('.triage-card')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close triage' }).click();
  await expect(page.getByLabel('Sort opportunities')).toHaveValue('salary');
});
