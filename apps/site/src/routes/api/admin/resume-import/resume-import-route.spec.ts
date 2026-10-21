import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  process: vi.fn(),
  receive: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('$lib/server/resume-import-runtime', () => ({
  getResumeImportHost: mocks.factory,
}));
vi.mock('$lib/server/owner-principal', () => ({
  OwnerPrincipalError: class extends Error {},
  isOwnerAuthorityDenial: () => false,
}));
vi.mock('$lib/server/resume-import-domain', () => ({
  ResumeImportDomainError: class extends Error {},
}));
vi.mock('$lib/server/resume-import-host', () => ({
  RESUME_IMPORT_MAX_BYTES: 10 * 1024 * 1024,
  ResumeImportHostError: class extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  },
}));

import { POST } from './+server';
import { GET } from './[id]/+server';

const url = new URL('https://example.test/api/admin/resume-import');
function event(form: FormData, authenticated = true) {
  return {
    locals: { user: authenticated ? { id: 'owner' } : null },
    url,
    request: new Request(url, { method: 'POST', body: form }),
  } as any;
}
function form(consent?: string) {
  const result = new FormData();
  result.set(
    'file',
    new File(['%PDF-test'], 'resume.pdf', { type: 'application/pdf' }),
  );
  result.set('requestId', 'request');
  if (consent !== undefined) result.set('consent', consent);
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.factory.mockResolvedValue({ receive: mocks.receive });
  mocks.receive.mockResolvedValue({
    id: 'import',
    status: 'review',
    revision: '1',
    filename: 'resume.pdf',
    entries: [],
    warnings: [],
  });
});
describe('resume upload route', () => {
  it('requires explicit provider consent before constructing the runtime', async () => {
    const response = await POST(event(form('false')));
    expect(response.status).toBe(400);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it('requires authentication before reading the upload', async () => {
    const response = await POST(event(form('true'), false));
    expect(response.status).toBe(401);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
  it('passes only validated file and request fields to the authenticated host', async () => {
    const response = await POST(event(form('true')));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.receive).toHaveBeenCalledWith({
      bytes: new TextEncoder().encode('%PDF-test'),
      filename: 'resume.pdf',
      requestId: 'request',
    });
  });
  it('rejects duplicate consent and forged ownership fields', async () => {
    const duplicate = form('true');
    duplicate.append('consent', 'true');
    const forged = form('true');
    forged.set('profileId', 'foreign');
    expect((await POST(event(duplicate))).status).toBe(400);
    expect((await POST(event(forged))).status).toBe(400);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
});
describe('resume import polling route', () => {
  it('returns a processing view from the durable host read without processing it', async () => {
    mocks.get.mockResolvedValue({
      id: 'import',
      status: 'processing',
      revision: '1',
      filename: 'resume.pdf',
      entries: [],
      warnings: [],
    });
    mocks.factory.mockResolvedValue({ get: mocks.get, process: mocks.process });
    const response = await GET({
      locals: { user: { id: 'owner' } },
      request: new Request(url),
      url,
      params: { id: 'import' },
    } as any);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.get).toHaveBeenCalledWith('import');
    expect(mocks.process).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      status: 'processing',
    });
  });
  it('denies an unauthenticated poll before constructing the host', async () => {
    const response = await GET({
      locals: { user: null },
      request: new Request(url),
      url,
      params: { id: 'import' },
    } as any);
    expect(response.status).toBe(401);
    expect(mocks.factory).not.toHaveBeenCalled();
  });
});
