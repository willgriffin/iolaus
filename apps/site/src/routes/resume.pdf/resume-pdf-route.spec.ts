import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensurePublishedResumePdf: vi.fn(),
}));

vi.mock('$lib/server/resume-admin', () => ({
  ensurePublishedResumePdf: mocks.ensurePublishedResumePdf,
}));

import { GET } from './+server';

beforeEach(() => {
  mocks.ensurePublishedResumePdf.mockReset();
  mocks.ensurePublishedResumePdf.mockResolvedValue({
    body: Buffer.from('%PDF-1.4 resume\n'),
    filename: 'internal-name.pdf',
  });
});

describe('public resume PDF route', () => {
  it('regenerates a missing public PDF and returns the stable download filename', async () => {
    const response = await GET({} as Parameters<typeof GET>[0]);

    expect(mocks.ensurePublishedResumePdf).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="resume.pdf"',
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from('%PDF-1.4 resume\n'),
    );
  });
});
