import { describe, expect, it, vi } from 'vitest';

const reader = vi.hoisted(() => ({
  extractMetadata: vi.fn(),
  extractText: vi.fn(),
}));
vi.mock('@happyvertical/pdf', () => ({ getPDFReader: async () => reader }));

import { createLocalResumePdfClient } from './local-resume-pdf.js';

describe('local PDF expanded content bounds', () => {
  it('rejects provider text above 120k characters before accepting a proposal', async () => {
    reader.extractMetadata.mockResolvedValue({ pageCount: 1 });
    reader.extractText.mockResolvedValue('x'.repeat(120_001));
    await expect(
      createLocalResumePdfClient().extract({
        bytes: new Uint8Array([1]),
        authorize: async () => {},
      }),
    ).rejects.toMatchObject({ category: 'limit' });
  });
});
