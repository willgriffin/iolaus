import { readFileSync } from 'node:fs';
import {
  type APIRequestContext,
  test as base,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { attachRuntimeFailure } from './evidence.js';

const test = base.extend<{ localNetwork: undefined }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
  baseURL: async ({}, use) => {
    if (!process.env.IOLAUS_E2E_ORIGIN) throw new Error('E2E origin missing');
    await use(process.env.IOLAUS_E2E_ORIGIN);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
  storageState: async ({}, use) => {
    if (!process.env.IOLAUS_E2E_AUTH)
      throw new Error('E2E owner session missing');
    await use(process.env.IOLAUS_E2E_AUTH);
  },
  localNetwork: [
    async ({ context, baseURL }, use) => {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === baseURL
          ? route.continue()
          : route.abort(),
      );
      await use(undefined);
    },
    { auto: true },
  ],
});

test.use({ actionTimeout: 15_000 });

// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
test.afterEach(async ({}, testInfo) => await attachRuntimeFailure(testInfo));

const syntheticOverride =
  'This is an isolated fictional QA posting with no employer or external destination. Prepare local review artifacts only.';

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  });
}

async function action(page: Page, button: Locator, name: string) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).searchParams.has(`/${name}`) &&
      (response.status() < 300 || response.status() >= 400),
  );
  await button.click();
  const response = await responsePromise;
  expect(response.status(), `${name} HTTP result`).toBe(200);
  const result = await response.json();
  expect(result.type, `${name} action result: ${JSON.stringify(result)}`).toBe(
    'success',
  );
  return result;
}

async function privateApplication(request: APIRequestContext, id: string) {
  const response = await request.get('/api/admin-resources/applications');
  expect(response.status()).toBe(200);
  const payload = await response.json();
  const record = payload.records.find((row: { id: string }) => row.id === id) as
    | Record<string, unknown>
    | undefined;
  expect(
    record,
    'Application remains visible to its native owner',
  ).toBeDefined();
  if (!record) throw new Error('Owned application projection missing');
  return record;
}

function expectNoExternalAuthorization(record: Record<string, unknown>) {
  expect(Boolean(record.approvedAt)).toBe(false);
  expect(Boolean(record.finalApprovalAt)).toBe(false);
  expect(record.finalApprovalKind).not.toBe('final_submission');
  expect(Boolean(record.submittedAt)).toBe(false);
  expect(['draft', 'application_drafting', 'awaiting_user']).toContain(
    record.status,
  );
}

async function generatePacket(page: Page) {
  const override = page.getByLabel('Reason to override the posting check');
  // The fictional posting intentionally has no live URL. Wait for its
  // client-loaded preflight form instead of racing an immediate count().
  await expect(override).toBeVisible();
  await override.fill(syntheticOverride);
  await action(
    page,
    page.getByRole('button', { name: /^(?:Re)?generate packet$/i }),
    'generatePacket',
  );
  await expect(
    page.getByRole('button', { name: 'Regenerate packet', exact: true }),
  ).toBeVisible();
}

async function inspectMaterialPdf(page: Page, material: 'Packet' | 'Resume') {
  await page
    .getByRole('navigation', { name: 'Application materials' })
    .getByRole('button', { name: material, exact: true })
    .click();
  const active = page.locator('.material-section:not([hidden])');
  const pdf = active.getByRole('link', { name: 'PDF', exact: true });
  await expect(pdf).toBeVisible();
  const href = await pdf.getAttribute('href');
  expect(href).toMatch(/^\/admin\/resume-assets\/[^/]+\/pdf$/);
  if (!href) throw new Error(`${material} PDF route missing`);
  const response = await page.context().request.get(href);
  expect(response.status(), `${material} PDF download`).toBe(200);
  expect(response.headers()['content-type']).toContain('application/pdf');
  expect((await response.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await active.getByText('Text source', { exact: true }).click();
  await expect(active.locator('pre')).toContainText(
    material === 'Resume' ? 'Jordan Example' : 'Application packet',
  );
  if (material === 'Packet') {
    // The fictional posting supplies no verified visa, EOR or relocation
    // assertion. Default booleans must not invent an employer denial.
    await expect(active.locator('pre')).toContainText(
      '- Visa/EOR possible: Unknown',
    );
    await expect(active.locator('pre')).toContainText(
      '- Relocation supported: Unknown',
    );
    await expect(active.locator('pre')).not.toContainText(
      '- Visa/EOR possible: no',
    );
    await expect(active.locator('pre')).not.toContainText(
      '- Relocation supported: no',
    );
  }
  return href;
}

test('owner prepares a draft with a selected resume and a tailored reviewable package without approving or submitting', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = JSON.parse(
    readFileSync(process.env.IOLAUS_E2E_FIXTURE as string, 'utf8'),
  ) as { resumeAssetId: string; applyingOpportunities: Record<string, string> };
  const opportunityId = fixture.applyingOpportunities[testInfo.project.name];
  if (!opportunityId) throw new Error('Applying readiness fixture missing');
  const title = `Applying readiness ${testInfo.project.name} fictional engineer`;

  // The selected default is a real upstream-rendered fictional PDF; the
  // fixture never imports or alters a real daily resume or published asset.
  const onboarding = await page.goto('/admin/onboarding');
  expect(onboarding?.status()).toBe(200);
  const resumeSelector = page.getByRole('combobox', {
    name: 'Resume asset',
    exact: true,
  });
  await expect(
    resumeSelector.locator(`option[value="${fixture.resumeAssetId}"]`),
  ).toHaveCount(1);
  await resumeSelector.selectOption(fixture.resumeAssetId);
  await action(
    page,
    page.getByRole('button', { name: 'Save private setup', exact: true }),
    'save',
  );
  await expect(page.getByText(/Saved private onboarding data/)).toBeVisible();
  await screenshot(page, testInfo, '01-selected-fictional-resume');

  const params = new URLSearchParams({
    q: title,
    review: 'unsorted',
    sort: 'salary',
    sortDirection: 'asc',
  });
  const list = await page.goto(`/admin/opportunities?${params}`);
  expect(list?.status()).toBe(200);
  await expect(page.locator('.table-opportunity .title-link')).toHaveText([
    title,
  ]);
  await page.getByRole('button', { name: /^Filters/ }).click();
  const filters = page.getByRole('dialog', { name: 'Opportunity filters' });
  await filters
    .getByRole('group', { name: 'Work mode' })
    .getByRole('button', { name: 'remote', exact: true })
    .click();
  await expect(page).toHaveURL(/workMode|workModes/);
  await filters
    .getByRole('button', { name: 'Close filters', exact: true })
    .click();
  await expect(filters).toHaveCount(0);
  await expect(page.locator('.table-opportunity .title-link')).toHaveText([
    title,
  ]);
  await screenshot(page, testInfo, '02-filtered-opportunity');

  await page.getByRole('button', { name: 'Triage', exact: true }).click();
  const triage = page.getByRole('dialog', { name: 'Triage opportunities' });
  await expect(triage.locator('.triage-card')).toHaveAttribute(
    'aria-label',
    `Triage card for ${title}`,
  );
  await screenshot(page, testInfo, '03-authenticated-triage');
  await triage
    .getByRole('link', { name: 'Open the full record', exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/admin/opportunities/${opportunityId}/?$`),
  );
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  const applicationForm = page.getByRole('region', {
    name: 'Application package',
    exact: true,
  });
  await applicationForm
    .getByRole('combobox', { name: 'Apply method', exact: true })
    .selectOption('other');
  await applicationForm
    .getByRole('combobox', { name: 'Resume', exact: true })
    .selectOption('default');
  await applicationForm
    .getByRole('combobox', { name: 'Cover letter', exact: true })
    .selectOption('none');
  await applicationForm
    .getByLabel('Instructions', { exact: true })
    .fill(
      'Fictional browser QA only. Prepare local artifacts; no employer contact, approval or submission.',
    );
  await applicationForm
    .getByLabel('Override inconclusive posting check', { exact: true })
    .fill(syntheticOverride);
  await action(
    page,
    applicationForm.getByRole('button', {
      name: 'Create draft application',
      exact: true,
    }),
    'createDraftApplication',
  );
  const openApplication = applicationForm.getByRole('link', {
    name: /^Open .* application$/,
  });
  await expect(openApplication).toBeVisible();
  const href = await openApplication.getAttribute('href');
  const applicationId = href?.split('/').filter(Boolean).at(-1);
  if (!applicationId) throw new Error('Draft application link missing');
  const draft = await privateApplication(context.request, applicationId);
  expectNoExternalAuthorization(draft);
  expect(draft.resumeMode).toBe('default');
  expect(draft.resumeAssetId).toBe(fixture.resumeAssetId);
  await screenshot(page, testInfo, '04-draft-created');

  await openApplication.click();
  await expect(page).toHaveURL(
    new RegExp(`/admin/applications/${applicationId}/?$`),
  );
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await generatePacket(page);
  const defaultPacketPdf = await inspectMaterialPdf(page, 'Packet');
  const defaultResumePdf = await inspectMaterialPdf(page, 'Resume');
  const defaultPackage = await privateApplication(
    context.request,
    applicationId,
  );
  expectNoExternalAuthorization(defaultPackage);
  expect(Boolean(defaultPackage.packetAssetId)).toBe(true);
  await screenshot(page, testInfo, '05-default-package-reviewable');

  // Updating the same owned draft exercises the actual tailored-generation
  // branch and keeps the owner responsible for the final review decision.
  await page.goto(`/admin/opportunities/${opportunityId}`);
  await applicationForm
    .getByRole('combobox', { name: 'Resume', exact: true })
    .selectOption('generate_tailored');
  await applicationForm
    .getByLabel('Override inconclusive posting check', { exact: true })
    .fill(syntheticOverride);
  await action(
    page,
    applicationForm.getByRole('button', { name: 'Update draft', exact: true }),
    'createDraftApplication',
  );
  await applicationForm
    .getByRole('link', { name: /^Open .* application$/ })
    .click();
  await generatePacket(page);
  const tailoredResumePdf = await inspectMaterialPdf(page, 'Resume');
  const tailoredPacketPdf = await inspectMaterialPdf(page, 'Packet');
  const tailoredPackage = await privateApplication(
    context.request,
    applicationId,
  );
  expectNoExternalAuthorization(tailoredPackage);
  expect(tailoredPackage.resumeMode).toBe('generate_tailored');
  expect(Boolean(tailoredPackage.resumeVariantId)).toBe(true);
  expect(tailoredPackage.resumeAssetId).not.toBe(defaultPackage.resumeAssetId);
  expect(tailoredResumePdf).not.toBe(defaultResumePdf);
  const width = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  await expect(
    page.getByRole('button', { name: 'Approve final submission', exact: true }),
  ).toBeVisible();
  await screenshot(page, testInfo, '06-tailored-package-reviewable-unapproved');
  await testInfo.attach('bounded applying-readiness outcomes', {
    contentType: 'application/json',
    body: JSON.stringify(
      {
        project: testInfo.project.name,
        opportunityId,
        applicationId,
        status: tailoredPackage.status,
        defaultPacketPdf,
        defaultResumePdf,
        tailoredPacketPdf,
        tailoredResumePdf,
        finalApproval: false,
        submitted: false,
        limits: [
          'Fictional owner/opportunity/resume in disposable native local runtime',
          'Fictional posting uses other apply method and explicit local preparation override',
          'No external provider response or hosted acceptance is claimed',
          'No approval, material-review mutation, publication, submission or outreach action was clicked',
        ],
      },
      null,
      2,
    ),
  });
});

test('resume history belongs to the authenticated owner and rejects foreign artifact actions', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const fixture = JSON.parse(
    readFileSync(process.env.IOLAUS_E2E_FIXTURE as string, 'utf8'),
  ) as { resumeAssetId: string };
  const ownerPage = await page.goto('/admin/resume');
  expect(ownerPage?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Jordan Example', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Resume admin views' })
    .getByRole('link', { name: 'PDF', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'PDF', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText('Fictional demo resume — generated text', { exact: false })
      .first(),
  ).toBeVisible();
  const ownerPdf = await page
    .context()
    .request.get(`/admin/resume-assets/${fixture.resumeAssetId}/pdf`);
  expect(ownerPdf.status()).toBe(200);
  expect((await ownerPdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  const ownerHistoryBefore = await page
    .context()
    .request.get('/api/admin-resources/resume-assets');
  expect(ownerHistoryBefore.status()).toBe(200);
  const before = (await ownerHistoryBefore.json()).records;
  await screenshot(page, testInfo, '07-owner-resume-history');
  const storageState = process.env.IOLAUS_E2E_FOREIGN_AUTH;
  if (!storageState) throw new Error('Foreign native session missing');
  const foreign = await browser.newContext({ baseURL, storageState });
  try {
    const foreignPage = await foreign.newPage();
    const response = await foreignPage.goto('/admin/resume');
    expect(response?.status()).toBe(200);
    await expect(
      foreignPage.getByRole('heading', {
        name: 'Fictional Foreign QA Candidate',
        exact: true,
      }),
    ).toBeVisible();
    await foreignPage
      .getByRole('navigation', { name: 'Resume admin views' })
      .getByRole('link', { name: 'PDF', exact: true })
      .click();
    await expect(
      foreignPage.getByRole('heading', { name: 'PDF', exact: true }),
    ).toBeVisible();
    await expect(
      foreignPage.getByText('Fictional demo resume — generated text', {
        exact: false,
      }),
    ).toHaveCount(0);
    const foreignPdf = await foreign.request.get(
      `/admin/resume-assets/${fixture.resumeAssetId}/pdf`,
    );
    expect([403, 404]).toContain(foreignPdf.status());
    for (const name of ['regenerate', 'publish']) {
      const denied = await foreign.request.post(`/admin/resume/?/${name}`, {
        headers: {
          origin: baseURL as string,
          accept: 'application/json',
          'x-sveltekit-action': 'true',
        },
        form: { assetId: fixture.resumeAssetId },
      });
      const result = await denied.json();
      // Enhanced SvelteKit forms transport ActionFailure inside HTTP 200.
      // Require the native denial result; a successful action is never valid.
      expect(['failure', 'error'], `${name} result`).toContain(result.type);
      expect([403, 404], `${name} native denial`).toContain(
        result.status ?? denied.status(),
      );
      expect(JSON.stringify(result)).not.toContain('Resume regenerated.');
    }
    const ownerHistoryAfter = await page
      .context()
      .request.get('/api/admin-resources/resume-assets');
    expect(ownerHistoryAfter.status()).toBe(200);
    expect((await ownerHistoryAfter.json()).records).toEqual(before);
    await screenshot(
      foreignPage,
      testInfo,
      '08-foreign-resume-history-isolated',
    );
  } finally {
    await foreign.close();
  }
});

test('row review closes only after a successful decision and preserves sequential triage and safe dismissals', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90_000);
  const prefix = `Sequence ${testInfo.project.name} Role`;
  const title = `${prefix} 1`;
  const listPath = `/admin/opportunities?${new URLSearchParams({
    q: prefix,
    review: 'unsorted',
    sort: 'salary',
    sortDirection: 'asc',
  })}`;
  let queueReads = 0;
  let decisionRequests = 0;
  context.on('request', (request) => {
    if (request.redirectedFrom()) return;
    const search = new URL(request.url()).search;
    if (search.includes('/triageQueue')) queueReads += 1;
    if (search.includes('/reviewOpportunity')) decisionRequests += 1;
  });
  await page.goto(listPath);
  const row = page.getByRole('row').filter({
    has: page.getByText(title, { exact: true }),
  });
  await expect(row).toHaveCount(1);
  const dialog = page.getByRole('dialog', { name: 'Triage opportunities' });
  const checkbox = row.getByRole('checkbox');
  await checkbox.check();
  await expect(dialog).toHaveCount(0);
  await checkbox.uncheck();
  const postingPopup = context.waitForEvent('page');
  await row.getByRole('link', { name: 'View posting', exact: true }).click();
  const blockedPosting = await postingPopup;
  await expect(dialog).toHaveCount(0);
  await blockedPosting.close();

  for (const dismissal of ['Close triage', 'Later', 'Escape']) {
    if (dismissal === 'Close triage') await row.press('Enter');
    else if (dismissal === 'Later') await row.press('Space');
    else await row.getByRole('cell').last().click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.triage-card')).toHaveAttribute(
      'aria-label',
      `Triage card for ${title}`,
    );
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else
      await dialog
        .getByRole('button', { name: dismissal, exact: true })
        .click();
    await expect(dialog).toHaveCount(0);
    expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe(
      '/admin/opportunities',
    );
  }
  expect(queueReads).toBe(0);
  expect(decisionRequests).toBe(0);

  await row.getByRole('cell').last().click();
  await dialog
    .getByRole('link', { name: 'Open opportunity', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.goto(listPath);

  const failureRoute = /\/admin\/opportunities\/?\?/;
  await page.route(failureRoute, async (route) => {
    if (new URL(route.request().url()).search.includes('/reviewOpportunity')) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'error',
          status: 500,
          error: { message: 'Isolated QA forced decision failure' },
        }),
      });
    } else await route.continue();
  });
  await row.getByRole('cell').last().click();
  await dialog.getByRole('button', { name: 'Nope', exact: true }).click();
  await expect(
    page.getByText('Isolated QA forced decision failure', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.triage-card')).toHaveAttribute(
    'aria-label',
    `Triage card for ${title}`,
  );
  await screenshot(page, testInfo, '09-single-row-failure-retains-card');
  await page.unroute(failureRoute);
  await action(
    page,
    dialog.getByRole('button', { name: 'Nope', exact: true }),
    'reviewOpportunity',
  );
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(queueReads).toBe(0);
  const rejected = await context.request.get(
    `/api/admin-resources/opportunities?${new URLSearchParams({ q: title, review: 'reject' })}`,
  );
  expect(rejected.status()).toBe(200);
  const records = (await rejected.json()).records as Array<{
    title: string;
    reviewOverlay: { humanReviewStatus: string } | null;
  }>;
  expect(records).toHaveLength(1);
  expect(records[0].title).toBe(title);
  expect(records[0].reviewOverlay?.humanReviewStatus).toBe('reject');

  await page.getByRole('button', { name: 'Triage', exact: true }).click();
  await expect(dialog.locator('.triage-card')).toHaveAttribute(
    'aria-label',
    `Triage card for ${prefix} 2`,
  );
  await dialog.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(dialog.locator('.triage-card')).toHaveAttribute(
    'aria-label',
    `Triage card for ${prefix} 3`,
  );
  expect(queueReads).toBeGreaterThan(0);
  expect(decisionRequests).toBe(2);
  await screenshot(page, testInfo, '10-sequential-triage-advances');
  await dialog
    .getByRole('button', { name: 'Close triage', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
});

test('Overview separates pending matches from scores and keeps private tasks in their owner workspace', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const fixture = JSON.parse(
    readFileSync(process.env.IOLAUS_E2E_FIXTURE as string, 'utf8'),
  ) as {
    opportunityId: string;
    applyingOpportunities: Record<string, string>;
  };
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true }),
  ).toBeVisible();
  const tasks = page.getByRole('region', { name: 'Priority tasks' });
  const priorityCards = tasks.locator('.task-list li');
  await expect(priorityCards.nth(0)).toContainText(
    'Fictional overdue priority task',
  );
  await expect(priorityCards.nth(0)).toContainText('Overdue');
  await expect(priorityCards.nth(1)).toContainText(
    'Fictional owner decision priority task',
  );
  await expect(priorityCards.nth(1)).toContainText('Needs your action');
  const opportunities = page.getByRole('region', {
    name: 'Best new opportunities',
  });
  // No current scored assessments are manufactured in this bounded fixture.
  await expect(opportunities.locator('.opportunity-list li')).toHaveCount(0);
  await expect(
    opportunities.getByText('No new assessed matches to show yet.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    opportunities.getByRole('heading', {
      name: 'Awaiting assessment or eligibility',
    }),
  ).toBeVisible();
  await expect(
    opportunities.getByText(/Score unavailable/).first(),
  ).toBeVisible();
  for (const id of [
    fixture.opportunityId,
    fixture.applyingOpportunities[testInfo.project.name],
  ]) {
    await expect(
      opportunities.locator(`a[href="/admin/opportunities/${id}"]`),
    ).toHaveCount(0);
  }
  const width = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1);
  await screenshot(page, testInfo, '11-owner-overview-pending-private-tasks');
  const storageState = process.env.IOLAUS_E2E_FOREIGN_AUTH;
  if (!storageState) throw new Error('Foreign native session missing');
  const foreign = await browser.newContext({ baseURL, storageState });
  try {
    const foreignPage = await foreign.newPage();
    await foreignPage.goto('/admin');
    await expect(
      foreignPage.getByRole('heading', { name: 'Overview', exact: true }),
    ).toBeVisible();
    const foreignTasks = foreignPage.getByRole('region', {
      name: 'Priority tasks',
    });
    await expect(foreignTasks.locator('.task-list li')).toHaveCount(0);
    await expect(
      foreignTasks.getByText('Review fictional demo application', {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      foreignTasks.getByText('Fictional overdue priority task', {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      foreignTasks.getByText('Fictional owner decision priority task', {
        exact: true,
      }),
    ).toHaveCount(0);
    await screenshot(
      foreignPage,
      testInfo,
      '12-foreign-overview-private-tasks-absent',
    );
  } finally {
    await foreign.close();
  }
});
