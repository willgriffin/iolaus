import { readFileSync } from 'node:fs';
import {
  type APIRequestContext,
  type BrowserContextOptions,
  test as base,
  expect,
} from '@playwright/test';
import { attachRuntimeFailure } from './evidence.js';

// This exercises a real browser, native cookie sessions and the MCP HTTP route.
// The controlled link renderer models host navigation only; external ChatGPT /
// Codex acceptance and the embedded bridge's conformance are separate evidence.
const test = base.extend({
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
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies are destructured.
test.afterEach(async ({}, testInfo) => await attachRuntimeFailure(testInfo));

async function callTool(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
) {
  return await request.post('/api/mcp', {
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      'mcp-protocol-version': '2026-07-28',
    },
    data: {
      jsonrpc: '2.0',
      id: 'authenticated-review',
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      },
    },
  });
}

async function inspect(request: APIRequestContext, applicationId: string) {
  const response = await callTool(request, 'job_search_inspect_application', {
    applicationId,
  });
  expect(response.status()).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  return envelope.result.structuredContent;
}

test('dedicated MCP review link authenticates the browser without approving or submitting', async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  const fixture = JSON.parse(
    readFileSync(process.env.IOLAUS_E2E_FIXTURE as string, 'utf8'),
  );
  const applicationId = fixture.applicationId as string;
  const before = await inspect(context.request, applicationId);
  expect(before.approval.recorded).toBe(false);
  expect(before.approval.final.recorded).toBe(false);
  expect(before.submission).toBeNull();
  const navigation = await callTool(
    context.request,
    'iolaus_open_human_review',
    {
      url: `/admin/applications/${applicationId}/review`,
    },
  );
  expect(navigation.status()).toBe(200);
  const envelope = await navigation.json();
  expect(envelope.error).toBeUndefined();
  expect(envelope.result.isError).not.toBe(true);
  const destination = envelope.result.structuredContent
    .humanReviewUrl as string;
  expect(destination).toBe(`/admin/applications/${applicationId}/review`);

  // Model the host's explicit open-link gesture with the destination returned by
  // the live server. Never inject credentials into the URL or rendered resource.
  await page.route('**/__e2e-review-link', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<a href="${destination}" target="_blank" rel="noopener noreferrer">Open dedicated review</a>`,
    }),
  );
  await page.goto('/__e2e-review-link');
  const requestedHeaders: Record<string, string>[] = [];
  context.on('request', (request) => {
    if (
      request.isNavigationRequest() &&
      new URL(request.url()).pathname.startsWith('/admin/applications/')
    ) {
      requestedHeaders.push(request.headers());
    }
  });
  const popupPromise = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Open dedicated review' }).click();
  const review = await popupPromise;
  await review.waitForURL(
    (url) =>
      url.origin === baseURL &&
      url.pathname.replace(/\/$/, '') ===
        `/admin/applications/${applicationId}`,
  );
  await expect(
    review
      .getByText('Fictional Principal Engineer — Iolaus Demo', { exact: false })
      .first(),
  ).toBeVisible();
  expect(await review.evaluate(() => window.opener === null)).toBe(true);
  expect(await review.evaluate(() => document.referrer)).toBe('');
  expect(requestedHeaders.length).toBeGreaterThan(0);
  expect(requestedHeaders.every((headers) => !headers.referer)).toBe(true);
  await review.screenshot({
    path: testInfo.outputPath('authenticated-review.png'),
    fullPage: true,
  });

  const foreignAuth = process.env.IOLAUS_E2E_FOREIGN_AUTH;
  if (!foreignAuth) throw new Error('E2E foreign session missing');
  const deniedActors: Array<
    [string, NonNullable<BrowserContextOptions['storageState']>]
  > = [
    ['anonymous', { cookies: [], origins: [] }],
    ['foreign', foreignAuth],
  ];
  for (const [actor, storageState] of deniedActors) {
    const deniedContext = await browser.newContext({ baseURL, storageState });
    try {
      // The legacy review loader redirects to the canonical application.
      // Check ownership at that actual private read boundary, then exercise
      // the dedicated link in the real browser below.
      const denied = await deniedContext.request.get(
        `/admin/applications/${applicationId}/`,
        {
          maxRedirects: 0,
          headers: {
            referer: `${baseURL}/admin/applications/${applicationId}`,
          },
        },
      );
      if (actor === 'anonymous') {
        expect([303, 401, 403], actor).toContain(denied.status());
      } else {
        // This page disables SSR: HTTP 200 serves an empty app shell. The
        // SvelteKit data endpoint carries the native private-record denial.
        expect(denied.status()).toBe(200);
        const data = await deniedContext.request.get(
          `/admin/applications/${applicationId}/__data.json?x-sveltekit-invalidated=011`,
        );
        const payload = (await data.json()) as {
          nodes?: Array<{ type?: string; status?: number }>;
        };
        expect(
          payload.nodes?.some(
            (node) =>
              node.type === 'error' && [403, 404].includes(node.status ?? 0),
          ),
          'Foreign canonical private load denies the record',
        ).toBe(true);
        expect(JSON.stringify(payload)).not.toContain(
          'Fictional Principal Engineer',
        );
      }
      expect(await denied.text(), actor).not.toContain(
        'Fictional Principal Engineer',
      );
      const forged = await callTool(
        deniedContext.request,
        'iolaus_open_human_review',
        { url: destination },
      );
      const body = await forged.json();
      expect(Boolean(body.error || body.result?.isError), actor).toBe(true);
      const deniedPage = await deniedContext.newPage();
      const response = await deniedPage.goto(destination);
      expect(response).not.toBeNull();
      if (actor === 'anonymous') {
        expect(new URL(deniedPage.url()).pathname.replace(/\/$/, '')).toBe(
          '/login',
        );
      } else {
        await expect(
          deniedPage.getByRole('heading', { name: /^(?:403|404)$/ }),
        ).toBeVisible();
        await expect(
          deniedPage.getByText('Fictional Principal Engineer', {
            exact: false,
          }),
        ).toHaveCount(0);
      }
      await deniedPage.screenshot({
        path: testInfo.outputPath(`${actor}-review-denied.png`),
        fullPage: true,
      });
    } finally {
      await deniedContext.close();
    }
  }
  const after = await inspect(context.request, applicationId);
  expect(after.approval).toEqual(before.approval);
  expect(after.submission).toEqual(before.submission);
  expect(after.application.status).toBe(before.application.status);
});
