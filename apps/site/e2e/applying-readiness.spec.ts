import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  type APIRequestContext,
  test as base,
  expect,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { attachRuntimeFailure } from './evidence.js';
import type { SourceCoverageProviderEvent } from './source-coverage-provider.js';

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

interface CoverageInspection {
  jobs: Array<{
    id: string;
    method: string;
    status: string;
    tenant_id: string;
    args: string | Record<string, unknown>;
    last_error: string | null;
  }>;
  receipts: Array<Record<string, unknown>>;
  assessments: Array<Record<string, unknown>>;
  posting: {
    sourceContentFingerprint: string;
    sourceContentVersion: number;
    preparedPostingJson: string;
  };
  coverage: { status: string; reason?: string };
  nativeDedupeIndex: boolean;
}

async function coverageRuntime(
  mode: 'inspect' | 'service' | 'revise',
  id: string,
): Promise<CoverageInspection> {
  const environmentPath = process.env.IOLAUS_E2E_RUNTIME_ENVIRONMENT;
  if (!environmentPath)
    throw new Error('Source coverage requires its opt-in isolated runtime');
  const environment = JSON.parse(
    readFileSync(environmentPath, 'utf8'),
  ) as NodeJS.ProcessEnv;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      resolve('node_modules/tsx/dist/cli.mjs'),
      resolve('e2e/source-coverage-runtime.ts'),
      mode,
      id,
    ],
    { env: environment, timeout: 160_000, maxBuffer: 20_000_000 },
  );
  const line = stdout
    .split('\n')
    .reverse()
    .find((line) => line.startsWith('IOLAUS_E2E_RESULT:'));
  if (!line) throw new Error('Native fixture inspection result missing');
  return JSON.parse(
    line.slice('IOLAUS_E2E_RESULT:'.length),
  ) as CoverageInspection;
}

function coverageEvents(): SourceCoverageProviderEvent[] {
  const path = process.env.IOLAUS_E2E_PROVIDER_EVENTS;
  if (!path) throw new Error('Source coverage provider event path missing');
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SourceCoverageProviderEvent);
}

function actionData(result: { data: unknown }): Record<string, unknown> {
  if (typeof result.data !== 'string')
    return result.data as Record<string, unknown>;
  // Enhanced SvelteKit actions use devalue references. This action contract has
  // only plain JSON primitives; decode those without importing browser aliases.
  const values = JSON.parse(result.data) as unknown[];
  // Values stored in the flat table are scalars, not references. Object fields
  // hold references into that table, so resolve each referenced scalar once.
  const resolveValue = (index: unknown): unknown => {
    if (typeof index !== 'number') return index;
    if (index < 0) return undefined;
    const value = values[index];
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveValue(item)]),
      );
    return value;
  };
  return resolveValue(0) as Record<string, unknown>;
}

function coverageFixture(project: string, scenario: string) {
  const fixture = JSON.parse(
    readFileSync(process.env.IOLAUS_E2E_FIXTURE as string, 'utf8'),
  ) as {
    sourceCoverageOpportunities: Record<string, Record<string, string>>;
    tenantId: string;
    userId: string;
    profileId: string;
  };
  const id = fixture.sourceCoverageOpportunities[project]?.[scenario];
  if (!id) throw new Error('Opt-in fictional source coverage posting missing');
  return { ...fixture, id };
}

async function assessCoverage(page: Page) {
  return actionData(
    await action(
      page,
      page.getByRole('button', { name: 'Assess', exact: true }),
      'processOpportunity',
    ),
  );
}

function expectSourceOnly(receipts: CoverageInspection['receipts']) {
  const source = receipts.filter(
    (row) =>
      String(row.feature).startsWith('opportunity-extraction') ||
      row.feature === 'opportunity-source-requirement-coverage',
  );
  expect(source.length).toBeGreaterThan(0);
  for (const row of source) {
    expect(row.tenant_id ?? '').toBe('');
    expect(row.owner_user_id ?? '').toBe('');
    expect(row.candidate_profile_id ?? '').toBe('');
    expect(String(row.output_json)).not.toMatch(
      /Jordan Example|jordan\.example|Foreign QA Candidate|candidateMaterialFingerprint/,
    );
  }
}

test('source coverage action creates native source and fresh private jobs, reuses verified cache, and fences stale and foreign assessments', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
    'Explicit isolated source-coverage transport opt-in required',
  );
  test.setTimeout(360_000);
  const fixture = coverageFixture(testInfo.project.name, 'ready');
  const id = fixture.id;
  await page.goto(`/admin/opportunities/${id}/`);
  const assessment = page.getByRole('region', {
    name: 'Your opportunity assessment',
  });
  await expect(
    assessment.getByText('Unknown', { exact: true }).first(),
  ).toBeVisible();
  const before = await coverageRuntime('inspect', id);
  expect(before.coverage.status).toBe('missing');
  expect(before.assessments).toHaveLength(0);
  const initial = await assessCoverage(page);
  expect(initial.stage).toBe('source_preparation');
  expect(initial.status).toBe('queued');
  expect(initial.sourceDependency).toMatchObject({
    kind: 'requirement_coverage',
    sourceContentFingerprint: before.posting.sourceContentFingerprint,
    sourceContentVersion: before.posting.sourceContentVersion,
  });
  await expect(
    page.getByText(
      /Source preparation queued\. Your private assessment will follow/,
    ),
  ).toBeVisible();
  await expect(assessment).not.toContainText('Match score:');
  const queued = await coverageRuntime('inspect', id);
  expect(queued.nativeDedupeIndex).toBe(true);
  expect(queued.jobs).toHaveLength(1);
  expect(queued.jobs[0]).toMatchObject({
    id: initial.jobId,
    method: 'prepareAssessmentCoverage',
    status: 'pending',
    tenant_id: fixture.tenantId,
  });
  const duplicate = await assessCoverage(page);
  expect(duplicate.jobId).toBe(initial.jobId);
  expect((await coverageRuntime('inspect', id)).jobs).toHaveLength(1);
  await screenshot(
    page,
    testInfo,
    'source-01-actionable-prerequisite-no-score',
  );
  const start = coverageEvents().length;
  const serviced = await coverageRuntime('service', id);
  await testInfo.attach('source-native-chain-before-assertions', {
    body: Buffer.from(JSON.stringify(serviced, null, 2)),
    contentType: 'application/json',
  });
  await testInfo.attach('source-provider-events-before-assertions', {
    body: Buffer.from(JSON.stringify(coverageEvents(), null, 2)),
    contentType: 'application/json',
  });
  expect(serviced.coverage.status).toBe('ready');
  expect(
    serviced.jobs.filter((job) => job.method === 'prepareAssessmentCoverage'),
  ).toHaveLength(1);
  expect(
    serviced.jobs.filter((job) => job.method === 'processIntelligence'),
  ).toHaveLength(1);
  expect(
    serviced.jobs.every((job) => job.status === 'completed'),
    JSON.stringify(serviced.jobs),
  ).toBe(true);
  expect(serviced.assessments).toHaveLength(1);
  expect(serviced.assessments[0]).toMatchObject({
    tenant_id: fixture.tenantId,
    owner_user_id: fixture.userId,
    candidate_profile_id: fixture.profileId,
    source_content_fingerprint: before.posting.sourceContentFingerprint,
    source_content_version: 1,
  });
  expectSourceOnly(serviced.receipts);
  const publicCache = JSON.stringify({
    preparedPostingJson: serviced.posting.preparedPostingJson,
    sourceOutputs: serviced.receipts
      .filter((row) => row.feature !== 'opportunity-assessment')
      .map((row) => row.output_json),
  });
  for (const privateIdentity of [
    fixture.tenantId,
    fixture.userId,
    fixture.profileId,
  ]) {
    expect(publicCache).not.toContain(privateIdentity);
  }
  const events = coverageEvents().slice(start);
  expect(events.map((event) => event.kind)).toEqual([
    'source_extraction',
    'source_audit',
    'private_assessment',
  ]);
  for (const event of events.filter(
    (event) => event.kind !== 'private_assessment',
  )) {
    expect(JSON.stringify(event.request)).not.toMatch(
      /Jordan Example|jordan\.example|Foreign QA Candidate|candidateMaterialFingerprint/,
    );
    for (const privateIdentity of [
      fixture.tenantId,
      fixture.userId,
      fixture.profileId,
    ]) {
      expect(JSON.stringify(event.request)).not.toContain(privateIdentity);
    }
  }
  await page.reload();
  await expect(assessment.getByText('Current', { exact: true })).toBeVisible();
  await assessment.scrollIntoViewIfNeeded();
  await screenshot(
    page,
    testInfo,
    'source-02-native-current-private-assessment',
  );
  await testInfo.attach('source-native-chain', {
    body: Buffer.from(JSON.stringify(serviced, null, 2)),
    contentType: 'application/json',
  });
  const cachedStart = coverageEvents().length;
  const cached = await assessCoverage(page);
  expect(cached.stage).toBe('private_assessment');
  expect(cached.sourceDependency).toBeUndefined();
  const fast = await coverageRuntime('service', id);
  expect(fast.coverage.status).toBe('ready');
  expect(
    fast.jobs.filter((job) => job.method === 'prepareAssessmentCoverage'),
  ).toHaveLength(1);
  expect(
    coverageEvents()
      .slice(cachedStart)
      .some((event) => event.kind !== 'private_assessment'),
  ).toBe(false);

  const foreign = await browser.newContext({
    baseURL,
    storageState: process.env.IOLAUS_E2E_FOREIGN_AUTH,
  });
  try {
    const foreignPage = await foreign.newPage();
    await foreignPage.goto(`/admin/opportunities/${id}/`);
    const foreignAssessment = foreignPage.getByRole('region', {
      name: 'Your opportunity assessment',
    });
    await expect(
      foreignAssessment.getByText('Unknown', { exact: true }).first(),
    ).toBeVisible();
    await expect(foreignAssessment).not.toContainText('Match score:');
    await expect(foreignAssessment).not.toContainText(
      'Current for this posting',
    );
    await expect(
      foreignAssessment.getByText('Current', { exact: true }),
    ).toHaveCount(0);
    await foreignAssessment.scrollIntoViewIfNeeded();
    await screenshot(
      foreignPage,
      testInfo,
      'source-03-foreign-assessment-absent',
    );
  } finally {
    await foreign.close();
  }

  // Change the owner profile through the real browser workflow. Global source
  // proof survives; the private result becomes stale before a fresh assessment.
  await page.goto('/admin/onboarding');
  await page
    .getByLabel('Professional summary', { exact: true })
    .fill(
      `Fictional changed candidate ${testInfo.project.name}; no external applications.`,
    );
  await action(
    page,
    page.getByRole('button', { name: 'Save private setup', exact: true }),
    'save',
  );
  await page.goto(`/admin/opportunities/${id}/`);
  await expect(
    assessment.getByText('Unknown', { exact: true }).first(),
  ).toBeVisible();
  const profileStart = coverageEvents().length;
  expect((await assessCoverage(page)).stage).toBe('private_assessment');
  const freshProfile = await coverageRuntime('service', id);
  expect(freshProfile.assessments.length).toBeGreaterThan(1);
  expect(
    coverageEvents()
      .slice(profileStart)
      .map((event) => event.kind),
  ).toEqual(['private_assessment']);
  expect(freshProfile.posting.preparedPostingJson).toBe(
    serviced.posting.preparedPostingJson,
  );
  await page.reload();
  await expect(assessment.getByText('Current', { exact: true })).toBeVisible();
  await coverageRuntime('revise', id);
  await page.reload();
  await expect(
    assessment.getByText('Unknown', { exact: true }).first(),
  ).toBeVisible();
  await expect(assessment).not.toContainText('Match score:');
  const revised = await assessCoverage(page);
  expect(revised.stage).toBe('source_preparation');
  expect(revised.sourceDependency).toMatchObject({ sourceContentVersion: 2 });
  await assessment.scrollIntoViewIfNeeded();
  await screenshot(
    page,
    testInfo,
    'source-04-source-revision-removes-stale-score',
  );
  const freshSource = await coverageRuntime('service', id);
  expect(freshSource.coverage.status).toBe('ready');
  expect(
    freshSource.assessments.some(
      (row) => Number(row.source_content_version) === 2,
    ),
  ).toBe(true);
  await page.reload();
  await expect(assessment.getByText('Current', { exact: true })).toBeVisible();
  await testInfo.attach('source-native-currentness', {
    body: Buffer.from(JSON.stringify(freshSource, null, 2)),
    contentType: 'application/json',
  });
});

test('source coverage failed provider and malformed audit block private continuation and repeated provider work', async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1',
    'Explicit isolated source-coverage transport opt-in required',
  );
  test.setTimeout(240_000);
  for (const scenario of ['provider-failure', 'audit-malformed']) {
    const { id } = coverageFixture(testInfo.project.name, scenario);
    await page.goto(`/admin/opportunities/${id}/`);
    expect((await assessCoverage(page)).stage).toBe('source_preparation');
    const outcome = await coverageRuntime('service', id);
    await testInfo.attach(`source-${scenario}-before-assertions`, {
      body: Buffer.from(JSON.stringify(outcome, null, 2)),
      contentType: 'application/json',
    });
    await testInfo.attach(`source-${scenario}-provider-events`, {
      body: Buffer.from(JSON.stringify(coverageEvents(), null, 2)),
      contentType: 'application/json',
    });
    expect(outcome.assessments).toHaveLength(0);
    expect(
      outcome.jobs.filter((job) => job.method === 'processIntelligence'),
    ).toHaveLength(0);
    expect(outcome.coverage.status).not.toBe('ready');
    const count = coverageEvents().length;
    await page.reload();
    const assessment = page.getByRole('region', {
      name: 'Your opportunity assessment',
    });
    await expect(
      assessment.getByText('Unknown', { exact: true }).first(),
    ).toBeVisible();
    await expect(assessment).not.toContainText('Match score:');
    const response = await action(
      page,
      page.getByRole('button', { name: 'Assess', exact: true }),
      'processOpportunity',
    );
    expect(actionData(response).status).toBe('error');
    expect(coverageEvents()).toHaveLength(count);
    expect((await coverageRuntime('inspect', id)).jobs).toHaveLength(1);
    await screenshot(
      page,
      testInfo,
      `source-${scenario}-blocked-no-private-score`,
    );
    await testInfo.attach(`source-${scenario}-native-state`, {
      body: Buffer.from(JSON.stringify(outcome, null, 2)),
      contentType: 'application/json',
    });
  }
});
