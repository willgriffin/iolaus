import { describe, expect, it, vi } from 'vitest';
import { createPublicHttpsFetch } from './public-https';
import { publicUrlIntakeCrawlOptions } from './url-intake-source-fetch';

const address = { address: '93.184.216.34', family: 4 as const };
function factory(
  transport: NonNullable<
    Parameters<typeof createPublicHttpsFetch>[0]
  >['transport'],
  lookup = vi.fn(async (_host: string) => [address]),
) {
  return {
    lookup,
    fetchFactory: (options: Parameters<typeof createPublicHttpsFetch>[0]) =>
      createPublicHttpsFetch({ ...options, lookup, transport }),
  };
}

describe('one-off URL intake crawl transport', () => {
  it('resolves static links against the validated redirected page, excluding script/comment anchors', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        Response.redirect('https://careers.example.com/team/', 302),
      )
      .mockResolvedValueOnce(
        new Response(
          '<script>"<a href="https://evil.example/a">fake</a>"</script><!-- <a href="secret">hidden</a> --><a href="jobs/123?x=1&amp;y=2"><b>Engineer</b></a><a href="javascript:alert(1)">bad</a>',
        ),
      );
    const deps = factory(transport);
    const options = await publicUrlIntakeCrawlOptions(
      'https://careers.example.com/start',
      deps,
    );
    const index = await options.adapterContext.scrapeIndex(
      'https://careers.example.com/start',
    );
    expect(index.url).toBe('https://careers.example.com/team/');
    expect(index.links).toEqual([
      {
        href: 'https://careers.example.com/team/jobs/123?x=1&y=2',
        text: 'Engineer',
      },
    ]);
    expect(index.metrics.interactionCount).toBe(0);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('guards derived ATS APIs and discovered link fetches using the same pinned transport', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const deps = factory(transport);
    const options = await publicUrlIntakeCrawlOptions(
      'https://jobs.ashbyhq.com/acme',
      deps,
    );
    await options.fetchImpl(
      'https://api.ashbyhq.com/posting-api/job-board/acme',
    );
    await options.adapterContext.fetchPage(
      'https://jobs.ashbyhq.com/acme/role',
    );
    expect(deps.lookup.mock.calls.map(([host]) => host)).toEqual([
      'jobs.ashbyhq.com',
      'api.ashbyhq.com',
      'jobs.ashbyhq.com',
    ]);
    expect(transport.mock.calls).toHaveLength(3);
  });

  it('refuses a private root or redirected destination before fetching that destination', async () => {
    const transport = vi.fn(async () =>
      Response.redirect('https://private.example.com/careers', 302),
    );
    const deps = factory(
      transport,
      vi.fn(async (host: string) =>
        host === 'private.example.com'
          ? [{ address: '127.0.0.1', family: 4 as const }]
          : [address],
      ),
    );
    await expect(
      publicUrlIntakeCrawlOptions('https://private.example.com/careers', deps),
    ).rejects.toThrow('public internet');
    expect(transport).not.toHaveBeenCalled();
    await expect(
      publicUrlIntakeCrawlOptions('https://careers.example.com', deps),
    ).rejects.toThrow('public internet');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('revalidates DNS for each request, refusing a rebinding after the public root', async () => {
    const transport = vi.fn(async () => new Response('root'));
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([address])
      .mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    const options = await publicUrlIntakeCrawlOptions(
      'https://careers.example.com',
      factory(transport, lookup),
    );
    await expect(
      options.adapterContext.fetchPage('https://careers.example.com/role'),
    ).rejects.toThrow('public internet');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('does not turn an upstream root failure into an empty successful index', async () => {
    await expect(
      publicUrlIntakeCrawlOptions(
        'https://careers.example.com',
        factory(async () => new Response('failed', { status: 503 })),
      ),
    ).rejects.toThrow('HTTP 503');
  });

  it('bounds the initial crawl and prohibits non-GET transport', async () => {
    const transport = vi.fn(async () => new Response('public'));
    const options = await publicUrlIntakeCrawlOptions(
      'https://careers.example.com',
      factory(transport),
    );
    await expect(
      options.fetchImpl('https://careers.example.com/role', { method: 'POST' }),
    ).rejects.toThrow('only GET');
    for (let i = 0; i < 63; i++)
      await options.fetchImpl(`https://careers.example.com/role/${i}`);
    await expect(
      options.fetchImpl('https://careers.example.com/over-limit'),
    ).rejects.toThrow('64-request limit');
    expect(transport).toHaveBeenCalledTimes(64);
  });

  it('counts every actual redirected network hop and refuses the 65th transport request', async () => {
    const transport = vi.fn(async (url: URL) => {
      const hop = Number(url.pathname.split('/')[2]);
      return url.pathname.startsWith('/hop/') && hop < 5
        ? Response.redirect(`https://careers.example.com/hop/${hop + 1}`, 302)
        : new Response('public');
    });
    const options = await publicUrlIntakeCrawlOptions(
      'https://careers.example.com/root',
      factory(transport),
    );
    for (let i = 0; i < 10; i++)
      await options.fetchImpl('https://careers.example.com/hop/0');
    expect(transport).toHaveBeenCalledTimes(61);
    await expect(
      options.fetchImpl('https://careers.example.com/hop/0'),
    ).rejects.toThrow('64-request limit');
    expect(transport).toHaveBeenCalledTimes(64);
    expect(String(transport.mock.calls[63]?.[0])).toBe(
      'https://careers.example.com/hop/2',
    );
  });
});
