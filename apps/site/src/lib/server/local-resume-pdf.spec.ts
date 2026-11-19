import { renderMarkdownToPdf } from '@happyvertical/pdf';
import { describe, expect, it, vi } from 'vitest';
import { createLocalResumePdfClient } from './local-resume-pdf.js';

// SDK-generated synthetic fixture exercises actual PDF bytes and native reader.
const fixture = () =>
  renderMarkdownToPdf(
    '# Morgan Example\n\nNorthwind Labs engineer. TypeScript and SQLite.',
  );
describe('local resume PDF reader', () => {
  it('reads a synthetic PDF in process with page evidence and no fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const authorize = vi.fn().mockResolvedValue(undefined);
    try {
      const result = await createLocalResumePdfClient().extract({
        bytes: await fixture(),
        authorize,
      });
      expect(result.text).toContain('[Page 1]');
      expect(result.text).toContain('Morgan Example');
      expect(result.pages).toHaveLength(1);
      expect(result.needsOcr).toBe(false);
      expect(authorize).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
  it('keeps page boundaries distinct and rejects oversized page counts', async () => {
    const bytes = await renderMarkdownToPdf(
      Array.from(
        { length: 65 },
        (_, i) => `Paragraph ${i}: synthetic career fact.`,
      ).join('\n\n'),
    );
    const result = await createLocalResumePdfClient().extract({
      bytes,
      authorize: async () => {},
    });
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages[0]?.text).toContain('Paragraph 0:');
    expect(result.pages[1]?.text).not.toContain('Paragraph 0:');
    await expect(
      createLocalResumePdfClient().extract({
        bytes: await renderMarkdownToPdf(
          'Synthetic paragraph.\n\n'.repeat(1200),
        ),
        authorize: async () => {},
      }),
    ).rejects.toMatchObject({ category: 'limit' });
  });
  it('never reads a revoked owner document', async () => {
    const denial = new Error('revoked');
    await expect(
      createLocalResumePdfClient().extract({
        bytes: await fixture(),
        authorize: async () => {
          throw denial;
        },
      }),
    ).rejects.toBe(denial);
  });
  it('rejects malformed, empty, oversized and cancelled input', async () => {
    const client = createLocalResumePdfClient();
    await expect(
      client.extract({
        bytes: new Uint8Array([1, 2]),
        authorize: async () => {},
      }),
    ).rejects.toMatchObject({ category: 'malformed_output' });
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(10 * 1024 * 1024 + 1),
    ])
      await expect(
        client.extract({ bytes, authorize: async () => {} }),
      ).rejects.toMatchObject({ category: 'limit' });
    await expect(
      client.extract({
        bytes: await fixture(),
        authorize: async () => {},
        signal: AbortSignal.abort(),
      }),
    ).rejects.toMatchObject({ category: 'cancelled' });
  });
  it('marks a blank PDF for manual entry without OCR', async () => {
    const result = await createLocalResumePdfClient().extract({
      bytes: await renderMarkdownToPdf(''),
      authorize: async () => {},
    });
    expect(result.needsOcr).toBe(true);
  });
});
