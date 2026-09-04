import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env.IOLAUS_DEMO_ORIGIN;
const cookie = process.env.IOLAUS_DEMO_SESSION_COOKIE;
const applicationId = process.env.IOLAUS_DEMO_APPLICATION_ID;
const screenshotPath = process.env.IOLAUS_DEMO_SCREENSHOT;
if (!origin || !cookie || !applicationId || !screenshotPath) {
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
  const result = await page.evaluate(async ({ applicationId }) => {
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
    if (!browseTool || !applicationTool) {
      throw new Error('The rendered page omitted required job-search tools.');
    }
    return {
      application: JSON.parse(
        await applicationTool.execute({ applicationId }),
      ) as Record<string, unknown>,
      browse: JSON.parse(
        await browseTool.execute({
          limit: 5,
          query: 'Fictional Principal Engineer',
        }),
      ) as Record<string, unknown>,
      schema: 'iolaus-demo-live-webmcp:v1',
      toolNames: tools.map((tool) => tool.name),
    };
  }, { applicationId });
  mkdirSync(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });
  console.log(JSON.stringify({ ...result, screenshotPath }));
} finally {
  await browser.close();
}
