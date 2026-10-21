import { json } from '@sveltejs/kit';
import {
  isOwnerAuthorityDenial,
  OwnerPrincipalError,
} from './owner-principal.js';
import { ResumeImportDomainError } from './resume-import-domain.js';
import { ResumeImportHostError } from './resume-import-host.js';

export function resumeImportTransportGuard(
  request: Request,
  url: URL,
  authenticated: boolean,
): Response | undefined {
  if (!authenticated)
    return json(
      { error: 'Sign in before importing a resume.' },
      { status: 401 },
    );
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin)
      return json(
        { error: 'Use the resume import form from this site.' },
        { status: 403 },
      );
  }
}
export function resumeImportTransportError(cause: unknown): Response {
  if (cause instanceof OwnerPrincipalError)
    return json(
      { error: 'Sign in before importing a resume.' },
      { status: 401 },
    );
  if (isOwnerAuthorityDenial(cause))
    return json(
      { error: 'You do not have permission to import a resume.' },
      { status: 403 },
    );
  if (cause instanceof ResumeImportHostError)
    return json(
      { error: cause.message, ...(cause.code ? { code: cause.code } : {}) },
      { status: cause.status },
    );
  if (cause instanceof ResumeImportDomainError)
    return json({ error: cause.message }, { status: 409 });
  // Upstream errors may include storage/provider data. Do not return or log them.
  return json(
    {
      error:
        'This import is unavailable or changed. Reload the review and try again.',
    },
    { status: 409 },
  );
}
/** Enforce the bound on streamed input too; Content-Length is not trusted. */
export async function readBoundedResumeImportBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > maximum)
    throw new ResumeImportHostError('The request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ResumeImportHostError('The request body is missing.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ResumeImportHostError('The request is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
export async function readResumeImportJSON(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new ResumeImportHostError('Send the review as JSON.', 415);
  try {
    return JSON.parse(
      new TextDecoder().decode(
        await readBoundedResumeImportBody(request, 512 * 1024),
      ),
    );
  } catch (cause) {
    if (cause instanceof ResumeImportHostError) throw cause;
    throw new ResumeImportHostError('Invalid JSON request.');
  }
}
