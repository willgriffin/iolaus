import type { Link, Page, SpiderAdapter } from '@happyvertical/spider';
import type { AdapterContext } from '@happyvertical/spider/platform';
import { htmlToPlainText } from './opportunity-details.js';
import {
  createPublicHttpsFetch,
  PUBLIC_HTTPS_TIMEOUT_MS,
} from './public-https.js';
import { SOURCE_CRAWL_TIMEOUT_MS } from './source-schedules.js';

/** Static link extraction never runs page scripts, loads assets, or accepts authentication headers. */
function linksFromHtml(content: string, base: string): Link[] {
  const links: Link[] = [];
  const markup = content.replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu,
    '',
  );
  for (const match of markup.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/giu,
  )) {
    if (links.length >= 1000) break;
    try {
      const url = new URL(
        (match[1] ?? match[2] ?? match[3] ?? '').replaceAll('&amp;', '&'),
        base,
      );
      if (url.protocol !== 'https:') continue;
      links.push({
        href: url.toString(),
        text: htmlToPlainText(match[4] ?? '').slice(0, 500),
      });
    } catch {
      /* Invalid links do not become crawl targets. */
    }
  }
  return links;
}

/** One bounded, public-only transport shared by API, HTML index and posting-detail paths. */
export async function publicUrlIntakeCrawlOptions(
  rootUrl: string,
  dependencies: {
    fetchFactory?: typeof createPublicHttpsFetch;
    now?: () => number;
  } = {},
) {
  const now = dependencies.now ?? Date.now;
  const deadlineAt = now() + SOURCE_CRAWL_TIMEOUT_MS;
  const fetchFactory = dependencies.fetchFactory ?? createPublicHttpsFetch;
  let requests = 0;
  const beforeTransport = () => {
    if (++requests > 64)
      throw new Error('This initial crawl reached its 64-request limit.');
  };
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    return await fetchFactory({
      deadlineAt: Math.min(deadlineAt, now() + PUBLIC_HTTPS_TIMEOUT_MS),
      beforeTransport,
    })(input, init);
  };
  const fetchPage = async (url: string): Promise<Page> => {
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(`The public page returned HTTP ${response.status}.`);
    const content = await response.text();
    const finalUrl = response.url || url;
    return {
      url: finalUrl,
      content,
      links: linksFromHtml(content, finalUrl),
      raw: null,
    };
  };
  // Fail an unsafe/unreachable pasted root before the native crawler can treat a failed index as empty.
  const root = await fetchPage(rootUrl);
  const cachedRoot = async (url: string) =>
    url === rootUrl ? root : await fetchPage(url);
  const spider: SpiderAdapter = { fetch: cachedRoot };
  const adapterContext: AdapterContext = {
    fetchPage: cachedRoot,
    scrapeIndex: async (url) => {
      const started = now();
      const page = await cachedRoot(url);
      return {
        ...page,
        strategy: {
          type: 'basic',
          spider: 'simple',
          config: {},
          confidence: 1,
        },
        metrics: {
          duration: now() - started,
          linkCount: page.links.length,
          interactionCount: 0,
          complete: false,
        },
      };
    },
  };
  return { fetchImpl, spider, adapterContext };
}
