import { renderMarkdownToPdf } from '@happyvertical/pdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({ resolve: vi.fn(), meter: vi.fn() }));
vi.mock('./ai-config.js', () => ({
  resolveExtractionAiProfileClient: ai.resolve,
}));
vi.mock('./ai-usage-guard.js', () => ({ meterAiWritingCall: ai.meter }));

import { extractResumeImport } from './resume-import-extraction.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('local resume import without AI', () => {
  it('offers only an editable, uncertain summary proposal and never calls AI', async () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
    const result = await extractResumeImport({
      bytes: await renderMarkdownToPdf(
        '# Morgan Example\n\nNorthwind Labs engineer.',
      ),
      evidence: { mediaType: 'application/pdf' },
      subject: { tenantId: 'tenant', userId: 'owner', profileId: 'profile' },
      authorize: async () => {},
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      kind: 'profile',
      uncertain: true,
      fields: { summary: expect.stringContaining('Morgan Example') },
    });
    expect(result.warnings.join(' ')).toContain('does not use AI');
    expect(ai.resolve).not.toHaveBeenCalled();
    expect(ai.meter).not.toHaveBeenCalled();
  });
  it('returns actionable manual setup guidance for blank PDFs', async () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
    const result = await extractResumeImport({
      bytes: await renderMarkdownToPdf(''),
      evidence: {},
      subject: { tenantId: 'tenant', userId: 'owner' },
      authorize: async () => {},
    });
    expect(result.entries).toEqual([]);
    expect(result.warnings.join(' ')).toContain('manually in Career');
    expect(ai.resolve).not.toHaveBeenCalled();
  });
});
