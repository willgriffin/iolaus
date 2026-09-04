import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.IOLAUS_DEMO_ORIGIN;
const cookie = process.env.IOLAUS_DEMO_SESSION_COOKIE;
const applicationId = process.env.IOLAUS_DEMO_APPLICATION_ID;
const crawlId = process.env.IOLAUS_DEMO_CRAWL_ID;
const opportunityId = process.env.IOLAUS_DEMO_OPPORTUNITY_ID;
const screenshotPath = process.env.IOLAUS_DEMO_SCREENSHOT;
const sourceId = process.env.IOLAUS_DEMO_SOURCE_ID;
const triageFollowupOpportunityId =
  process.env.IOLAUS_DEMO_TRIAGE_FOLLOWUP_OPPORTUNITY_ID;
const triageOpportunityId = process.env.IOLAUS_DEMO_TRIAGE_OPPORTUNITY_ID;
if (
  !origin ||
  !cookie ||
  !applicationId ||
  !crawlId ||
  !opportunityId ||
  !screenshotPath ||
  !sourceId ||
  !triageFollowupOpportunityId ||
  !triageOpportunityId
) {
  throw new Error('The authenticated demo WebMCP inputs are incomplete.');
}

function browserExecutable(): string {
  const candidates = [
    process.env.IOLAUS_DEMO_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((value): value is string => Boolean(value));
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      'The browser proof requires Chrome/Chromium or IOLAUS_DEMO_BROWSER_EXECUTABLE.',
    );
  }
  return executable;
}

const separator = cookie.indexOf('=');
if (separator < 1) throw new Error('The demo session cookie is invalid.');
const browser = await chromium.launch({
  executablePath: browserExecutable(),
  headless: true,
});
try {
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      url: origin,
      value: cookie.slice(separator + 1),
    },
  ]);
  await context.addInitScript(() => {
    const registered: Array<{
      execute: (input: Record<string, unknown>) => Promise<string>;
      name: string;
    }> = [];
    Object.defineProperty(globalThis, '__iolausRegisteredWebMcpTools', {
      configurable: false,
      value: registered,
    });
    Object.defineProperty(document, 'modelContext', {
      configurable: false,
      value: {
        async registerTool(tool: (typeof registered)[number]) {
          registered.push(tool);
        },
      },
    });
  });
  const page = await context.newPage();
  await page.goto(new URL('/admin/', origin).toString(), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () =>
      (
        globalThis as typeof globalThis & {
          __iolausRegisteredWebMcpTools?: unknown[];
        }
      ).__iolausRegisteredWebMcpTools?.length,
  );
  const result = await page.evaluate(async ({
    applicationId,
    crawlId,
    opportunityId,
    sourceId,
    triageFollowupOpportunityId,
    triageOpportunityId,
  }) => {
    const tools = (
      globalThis as typeof globalThis & {
        __iolausRegisteredWebMcpTools: Array<{
          execute: (input: Record<string, unknown>) => Promise<string>;
          name: string;
        }>;
      }
    ).__iolausRegisteredWebMcpTools;
    const browseTool = tools.find(
      (tool) => tool.name === 'job_search_browse_opportunities',
    );
    const applicationTool = tools.find(
      (tool) => tool.name === 'job_search_inspect_application',
    );
    const prepareTool = tools.find(
      (tool) => tool.name === 'job_search_open_application',
    );
    const sourceHealthTool = tools.find(
      (tool) => tool.name === 'job_search_list_source_health',
    );
    const crawlStatusTool = tools.find(
      (tool) => tool.name === 'job_search_source_crawl_status',
    );
    const nextTriageTool = tools.find(
      (tool) => tool.name === 'job_search_next_triage_candidate',
    );
    const inspectTool = tools.find(
      (tool) => tool.name === 'job_search_inspect_opportunity',
    );
    const decisionTool = tools.find(
      (tool) => tool.name === 'job_search_record_decision',
    );
    if (
      !browseTool ||
      !applicationTool ||
      !prepareTool ||
      !sourceHealthTool ||
      !crawlStatusTool ||
      !nextTriageTool ||
      !inspectTool ||
      !decisionTool
    ) {
      throw new Error('The rendered page omitted required job-search tools.');
    }
    let currentTool = 'source health';
    try {
      const sourceHealth = JSON.parse(
        await sourceHealthTool.execute({ limit: 5, query: 'fictional' }),
      ) as Record<string, unknown>;
      currentTool = 'crawl status';
      const crawlStatus = JSON.parse(
        await crawlStatusTool.execute({ crawlId, sourceId }),
      ) as Record<string, unknown>;
      currentTool = 'browse opportunities';
      const browse = JSON.parse(await browseTool.execute({
        limit: 5,
        query: 'Fictional Principal Engineer',
      })) as Record<string, unknown>;
      currentTool = 'open application';
      const preparation = JSON.parse(await prepareTool.execute({
        opportunityId,
        reason: 'Synthetic demo preparation; no external transmission.',
      })) as Record<string, unknown>;
      currentTool = 'inspect application';
      const application = JSON.parse(
        await applicationTool.execute({ applicationId }),
      ) as Record<string, unknown>;
      currentTool = 'next triage candidate';
      const triage = JSON.parse(
        await nextTriageTool.execute({
          query: 'Fictional Staff Engineer',
          sort: 'newest',
        }),
      ) as Record<string, unknown>;
      currentTool = 'inspect triage candidate';
      const triageInspection = JSON.parse(
        await inspectTool.execute({ opportunityId: triageOpportunityId }),
      ) as Record<string, unknown>;
      const reviewNote =
        'Fictional demo review note: keep this local and ask the user before applying.';
      currentTool = 'record decision';
      const decision = JSON.parse(await decisionTool.execute({
        decision: 'maybe',
        opportunityId: triageOpportunityId,
        reason: reviewNote,
      })) as Record<string, unknown>;
      currentTool = 'inspect persisted decision';
      const persistedTriage = JSON.parse(
        await inspectTool.execute({ opportunityId: triageOpportunityId }),
      ) as Record<string, unknown>;
      currentTool = 'advance triage queue';
      const advancedTriage = JSON.parse(
        await nextTriageTool.execute({
          query: 'Fictional Staff Engineer',
          sort: 'newest',
        }),
      ) as Record<string, unknown>;
      return {
        application,
        browse,
        crawlStatus,
        decision,
        preparation,
        persistedTriage,
        schema: 'iolaus-demo-live-webmcp:v1',
        sourceHealth,
        toolNames: tools.map((tool) => tool.name),
        triage,
        triageInspection,
        advancedTriage,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`${currentTool} failed: ${message}`, { cause });
    }
  }, {
    applicationId,
    crawlId,
    opportunityId,
    sourceId,
    triageFollowupOpportunityId,
    triageOpportunityId,
  });
  await page.goto(new URL('/admin/opportunities?triage=1', origin).toString(), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('dialog[aria-label="Triage opportunities"][open]');
  await page.getByText('Fictional Staff Engineer — Iolaus Triage Follow-up').waitFor();
  mkdirSync(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  console.log(
    JSON.stringify({
      ...result,
      screenshotPath,
      triageFollowupVisible: true,
      triageModalVisible: true,
    }),
  );
} finally {
  await browser.close();
}
