import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPDFReader } from '@happyvertical/pdf';
import { type APIRequestContext, expect, test } from '@playwright/test';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/desktop-mvp.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const phase = process.env.IOLAUS_DESKTOP_PHASE;

type Checkpoint = {
  origin: string;
  instance: string;
  opportunityId: string;
  applicationId: string;
  pdfs: Array<{ href: string; sha256: string }>;
};

test('installed local sidecar preserves a private synthetic application across restart', async ({
  browser,
}, testInfo) => {
  test.skip(
    !phase,
    'Use desktop-mvp.config.ts and the documented phase command.',
  );
  expect(['create', 'verify']).toContain(phase);
  const rawOrigin = process.env.IOLAUS_DESKTOP_ORIGIN;
  const stateDirectory = process.env.IOLAUS_DESKTOP_STATE_DIR;
  if (!rawOrigin || !stateDirectory)
    throw new Error('Set IOLAUS_DESKTOP_ORIGIN and IOLAUS_DESKTOP_STATE_DIR.');
  const originUrl = new URL(rawOrigin);
  expect(originUrl.protocol).toBe('http:');
  expect(['127.0.0.1', '[::1]']).toContain(originUrl.hostname);
  expect(originUrl.pathname).toBe('/');
  expect(originUrl.search).toBe('');
  expect(originUrl.hash).toBe('');
  expect(originUrl.username + originUrl.password).toBe('');
  const origin = originUrl.origin;
  const state = resolve(stateDirectory);
  const repository = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  expect(state === repository || state.startsWith(`${repository}/`)).toBe(
    false,
  );
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const sessionPath = join(state, 'owner-session.json');
  const checkpointPath = join(state, 'checkpoint.json');
  const context = await browser.newContext({
    baseURL: origin,
    ...(phase === 'verify' ? { storageState: sessionPath } : {}),
  });
  const blocked: string[] = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    blocked.push(url.origin);
    return route.abort();
  });
  const page = await context.newPage();
  try {
    const healthResponse = await context.request.get('/api/_runtime/health');
    expect(healthResponse.status()).toBe(200);
    const health = await healthResponse.json();
    expect(health.status).toBe('ready');
    expect(health.profile).toBe('local');
    expect(typeof health.instance).toBe('string');
    expect(health.instance.length).toBeGreaterThan(0);

    async function record(resource: string, id: string) {
      const response = await context.request.get(
        `/api/admin-resources/${resource}`,
      );
      expect(response.status()).toBe(200);
      const payload = await response.json();
      const found = payload.records.find(
        (row: { id: string }) => row.id === id,
      );
      expect(found, `Persisted owned ${resource} record`).toBeDefined();
      return found as Record<string, unknown>;
    }

    async function inspectPdf(request: APIRequestContext, href: string) {
      expect(href).toMatch(/^\/admin\/resume-assets\/[^/]+\/pdf$/);
      const response = await request.get(href);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('application/pdf');
      const bytes = await response.body();
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      const reader = await getPDFReader({ provider: 'unpdf' });
      const text = await reader.extractText(new Uint8Array(bytes), {
        skipOCRFallback: true,
      });
      expect(text).toContain(fixture.name);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(join(state, `${sha256}.pdf`), bytes, { mode: 0o600 });
      return { href, sha256 };
    }

    function expectPrivateDraft(application: Record<string, unknown>) {
      expect(application.approvedAt || null).toBeNull();
      expect(application.finalApprovalAt || null).toBeNull();
      expect(application.submittedAt || null).toBeNull();
      expect(application.finalApprovalKind).not.toBe('final_submission');
      expect(['draft', 'application_drafting', 'awaiting_user']).toContain(
        application.status,
      );
    }

    if (phase === 'verify') {
      const checkpoint = JSON.parse(
        readFileSync(checkpointPath, 'utf8'),
      ) as Checkpoint;
      expect(new URL(checkpoint.origin).hostname).toBe(originUrl.hostname);
      expect(
        health.instance,
        'Sidecar must actually restart between phases',
      ).not.toBe(checkpoint.instance);
      await page.goto('/admin/onboarding');
      await expect(
        page.getByLabel('Display name', { exact: true }),
      ).toHaveValue(fixture.name);
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(
        fixture.email,
      );
      await page.goto('/admin/career');
      await expect(
        page.getByText(fixture.summary, { exact: false }).first(),
      ).toBeVisible();
      expect(
        (await record('opportunities', checkpoint.opportunityId)).status,
      ).toBe('apply');
      expectPrivateDraft(
        await record('applications', checkpoint.applicationId),
      );
      await page.goto(`/admin/applications/${checkpoint.applicationId}`);
      await expect(
        page.getByRole('heading', { name: fixture.jobTitle, exact: true }),
      ).toBeVisible();
      for (const pdf of checkpoint.pdfs)
        expect(await inspectPdf(context.request, pdf.href)).toEqual(pdf);
      await page.screenshot({
        path: testInfo.outputPath('after-restart.png'),
        fullPage: true,
      });
    } else {
      const handoffPath = process.env.IOLAUS_DESKTOP_OWNER_LINK_FILE;
      if (!handoffPath)
        throw new Error(
          'Set IOLAUS_DESKTOP_OWNER_LINK_FILE using desktop-mvp-owner-link.mjs.',
        );
      const handoff = JSON.parse(readFileSync(handoffPath, 'utf8')) as {
        url: string;
      };
      const ownerLink = new URL(handoff.url);
      expect(ownerLink.origin).toBe(origin);
      expect(ownerLink.pathname).toBe('/api/_runtime/owner-link');
      expect(Boolean(ownerLink.searchParams.get('launch'))).toBe(true);
      // Exercise the same native owner transaction as the installed WebView.
      // Fetch keeps the per-launch credential out of browser URLs/failure logs.
      await page.goto('/');
      const status = await page.evaluate(async (launch) => {
        const response = await fetch(
          `/api/_runtime/owner-link?launch=${encodeURIComponent(launch)}`,
        );
        return response.status;
      }, ownerLink.searchParams.get('launch') as string);
      expect(status).toBe(200);
      await page.goto('/admin/onboarding');
      await expect(
        page.getByLabel('Display name', { exact: true }),
      ).toBeVisible();
      for (const [label, value] of [
        ['Display name', fixture.name],
        ['First name', fixture.firstName],
        ['Last name', fixture.lastName],
        ['Email', fixture.email],
        ['Current location', fixture.location],
      ])
        await page.getByLabel(label, { exact: true }).fill(value);
      await page
        .getByRole('button', { name: 'Save private setup', exact: true })
        .click();
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Saved private onboarding data' }),
      ).toBeVisible();
      await page.goto('/admin/career');
      await page
        .getByRole('button', { name: `Edit ${fixture.name}`, exact: true })
        .click();
      const editor = page.locator('#resume-inline-editor');
      await editor
        .getByLabel('Professional title', { exact: true })
        .fill(fixture.title);
      await editor.getByLabel('Summary', { exact: true }).fill(fixture.summary);
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByText(fixture.summary, { exact: false }).first(),
      ).toBeVisible();
      await page.goto('/admin/resume?tab=pdf');
      await page
        .getByRole('button', { name: 'Canonical resume', exact: true })
        .click();
      const pdfLink = page
        .getByRole('link', { name: 'Open PDF', exact: true })
        .first();
      await expect(pdfLink).toBeVisible();
      const resumePdf = await pdfLink.getAttribute('href');
      if (!resumePdf) throw new Error('Canonical PDF link missing.');
      const pdfs = [await inspectPdf(context.request, resumePdf)];
      const resumeId = resumePdf.split('/')[3];
      await page.goto('/admin/onboarding');
      await page
        .getByRole('combobox', { name: 'Resume asset', exact: true })
        .selectOption(resumeId);
      await page
        .getByRole('button', { name: 'Save private setup', exact: true })
        .click();
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Saved private onboarding data' }),
      ).toBeVisible();
      await page.goto('/admin/opportunities/new');
      await page.getByLabel('Title', { exact: true }).fill(fixture.jobTitle);
      await page
        .getByLabel('Posting URL', { exact: true })
        .fill(fixture.postingUrl);
      await page
        .getByLabel('Description', { exact: true })
        .fill(fixture.description);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/opportunities\/[^/]+\/?$/);
      const opportunityId = new URL(page.url()).pathname
        .split('/')
        .filter(Boolean)
        .at(-1);
      if (!opportunityId) throw new Error('Created opportunity ID missing.');
      const draft = page.getByRole('region', {
        name: 'Application package',
        exact: true,
      });
      await draft
        .getByRole('combobox', { name: 'Apply method', exact: true })
        .selectOption('other');
      await draft
        .getByRole('combobox', { name: 'Resume', exact: true })
        .selectOption('default');
      await draft
        .getByRole('combobox', { name: 'Cover letter', exact: true })
        .selectOption('none');
      await draft
        .getByLabel('Instructions', { exact: true })
        .fill(fixture.instructions);
      await draft
        .getByLabel('Override inconclusive posting check', { exact: true })
        .fill(fixture.override);
      await draft
        .getByRole('button', { name: 'Create draft application', exact: true })
        .click();
      const applicationLink = draft.getByRole('link', {
        name: /^Open .* application$/,
      });
      await expect(applicationLink).toBeVisible();
      await applicationLink.click();
      await expect(page).toHaveURL(/\/admin\/applications\/[^/]+\/?$/);
      const applicationId = new URL(page.url()).pathname
        .split('/')
        .filter(Boolean)
        .at(-1);
      if (!applicationId) throw new Error('Draft application ID missing.');
      const override = page.getByLabel('Reason to override the posting check');
      if (await override.count()) await override.fill(fixture.override);
      await page
        .getByRole('button', { name: 'Generate packet', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Regenerate packet', exact: true }),
      ).toBeVisible();
      const application = await record('applications', applicationId);
      expectPrivateDraft(application);
      expect(application.resumeAssetId).toBe(resumeId);
      expect(application.packetAssetId).toBeTruthy();
      pdfs.push(
        await inspectPdf(
          context.request,
          `/admin/resume-assets/${application.packetAssetId}/pdf`,
        ),
      );
      await page
        .getByRole('navigation', { name: 'Application materials' })
        .getByRole('button', { name: 'Resume', exact: true })
        .click();
      await expect(
        page
          .locator('.material-section:not([hidden])')
          .getByRole('link', { name: 'PDF', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('prepared-materials.png'),
        fullPage: true,
      });
      await page.goto(`/admin/opportunities/${opportunityId}/edit`);
      await page.getByLabel('Status', { exact: true }).selectOption('apply');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await record('opportunities', opportunityId)).status).toBe(
        'apply',
      );
      expectPrivateDraft(await record('applications', applicationId));
      const checkpoint: Checkpoint = {
        origin,
        instance: health.instance,
        opportunityId,
        applicationId,
        pdfs,
      };
      writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), {
        mode: 0o600,
      });
      writeFileSync(sessionPath, JSON.stringify(await context.storageState()), {
        mode: 0o600,
      });
    }
    expect(blocked, 'Browser attempted external network access').toEqual([]);
  } finally {
    await context.close();
  }
});
