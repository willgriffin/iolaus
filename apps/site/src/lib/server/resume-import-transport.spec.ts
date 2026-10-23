import { describe, expect, it, vi } from 'vitest';
import { ResumeImportLifecycleBusyError } from './resume-import-account-fence.js';

vi.mock('./owner-principal.js', () => ({
  OwnerPrincipalError: class extends Error {},
  isOwnerAuthorityDenial: () => false,
}));
vi.mock('./resume-import-domain.js', () => ({
  ResumeImportDomainError: class extends Error {},
}));
vi.mock('./resume-import-host.js', () => ({
  ResumeImportHostError: class extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  },
}));

import {
  readBoundedResumeImportBody,
  readResumeImportJSON,
  resumeImportTransportError,
  resumeImportTransportGuard,
} from './resume-import-transport.js';

describe('resume import transport boundary', () => {
  it('returns a safe actionable retry for lifecycle capacity refusals', async () => {
    const response = resumeImportTransportError(
      new ResumeImportLifecycleBusyError(),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(await response.json()).toMatchObject({
      code: 'resume_lifecycle_busy',
      error: expect.stringContaining('try again'),
    });
  });
  it('requires sign-in and rejects cross-origin mutation', () => {
    const url = new URL('https://example.test/api/admin/resume-import');
    expect(
      resumeImportTransportGuard(new Request(url), url, false)?.status,
    ).toBe(401);
    expect(
      resumeImportTransportGuard(
        new Request(url, {
          method: 'DELETE',
          headers: { origin: 'https://foreign.test' },
        }),
        url,
        true,
      )?.status,
    ).toBe(403);
  });
  it('bounds streamed requests even without Content-Length', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: '123456',
    });
    await expect(readBoundedResumeImportBody(request, 5)).rejects.toThrow(
      'too large',
    );
  });
  it('rejects malformed JSON and unsupported content type', async () => {
    await expect(
      readResumeImportJSON(
        new Request('https://example.test', { method: 'POST', body: '{}' }),
      ),
    ).rejects.toThrow('JSON');
    await expect(
      readResumeImportJSON(
        new Request('https://example.test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{',
        }),
      ),
    ).rejects.toThrow('Invalid JSON');
  });
  it('does not expose provider text, file paths or private input in errors', async () => {
    const response = resumeImportTransportError(
      new Error('secret-token private resume /private/storage'),
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toMatch(
      /secret-token|private resume|private\/storage/u,
    );
  });
});
