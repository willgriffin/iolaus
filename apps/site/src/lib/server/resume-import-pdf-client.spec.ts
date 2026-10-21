import { describe, expect, it, vi } from 'vitest';
import {
  createResumeImportPdfClient,
  type ResumeImportPdfClientError,
} from './resume-import-pdf-client.js';

const body = JSON.stringify({
  pages: [{ page: 1, text: 'Fictional resume' }],
  needsOcr: false,
});
describe('resume import PDF client', () => {
  it('authorizes immediately before one bounded no-redirect request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(body));
    const client = createResumeImportPdfClient(
      'http://resume-extractor:8080',
      fetcher,
    )!;
    const authorize = vi.fn().mockResolvedValue(undefined);
    await expect(
      client.extract({ bytes: new Uint8Array([1]), authorize }),
    ).resolves.toMatchObject({ text: '[Page 1]\nFictional resume' });
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: expect.objectContaining({ 'content-type': 'application/pdf' }),
    });
  });
  it('rejects an oversized streamed response without accepting it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('x'.repeat(1_000_001)));
    const client = createResumeImportPdfClient(
      'http://resume-extractor:8080',
      fetcher,
    )!;
    await expect(
      client.extract({ bytes: new Uint8Array(), authorize: async () => {} }),
    ).rejects.toMatchObject({
      category: 'malformed_output',
    } satisfies Partial<ResumeImportPdfClientError>);
  });
  it('fails closed for an invalid configured origin', () => {
    try {
      createResumeImportPdfClient('https://user:pass@example.test');
      throw new Error('expected invalid URL rejection');
    } catch (error) {
      expect(error).toMatchObject({ category: 'unavailable' });
    }
  });
  it('does not authorize or call a service after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    const client = createResumeImportPdfClient(
      'http://resume-extractor:8080',
      fetcher,
    )!;
    const authorize = vi.fn();
    await expect(
      client.extract({
        bytes: new Uint8Array(),
        authorize,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(authorize).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('marks blank returned pages for OCR even when the service misses it', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ pages: [{ page: 1, text: '' }], needsOcr: false }),
        ),
      );
    const client = createResumeImportPdfClient(
      'http://resume-extractor:8080',
      fetcher,
    )!;
    await expect(
      client.extract({ bytes: new Uint8Array(), authorize: async () => {} }),
    ).resolves.toMatchObject({ needsOcr: true });
  });
});
