import { json, type RequestHandler } from '@sveltejs/kit';
import {
  RESUME_IMPORT_MAX_BYTES,
  ResumeImportHostError,
} from '$lib/server/resume-import-host';
import { getResumeImportHost } from '$lib/server/resume-import-runtime';
import {
  readBoundedResumeImportBody,
  resumeImportTransportError,
  resumeImportTransportGuard,
} from '$lib/server/resume-import-transport';

export const POST: RequestHandler = async ({ locals, request, url }) => {
  const denied = resumeImportTransportGuard(request, url, Boolean(locals.user));
  if (denied) return denied;
  try {
    const contentType = request.headers.get('content-type');
    if (!contentType?.startsWith('multipart/form-data;'))
      throw new ResumeImportHostError(
        'Choose a PDF file using the upload form.',
        415,
      );
    const bytes = await readBoundedResumeImportBody(
      request,
      RESUME_IMPORT_MAX_BYTES + 64 * 1024,
    );
    const form = await new Response(bytes.buffer as ArrayBuffer, {
      headers: { 'content-type': contentType },
    }).formData();
    if (
      [...form.keys()].some(
        (key) => !['file', 'requestId', 'consent', 'newImport'].includes(key),
      ) ||
      ['file', 'requestId', 'consent'].some(
        (key) => form.getAll(key).length !== 1,
      )
    )
      throw new ResumeImportHostError('Invalid upload form.');
    if (
      form.getAll('newImport').length > 1 ||
      (form.has('newImport') && form.get('newImport') !== 'true')
    )
      throw new ResumeImportHostError('Invalid new import choice.');
    if (form.get('consent') !== 'true')
      throw new ResumeImportHostError(
        'Confirm AI processing before uploading your resume.',
      );
    const file = form.get('file');
    const requestId = form.get('requestId');
    if (!(file instanceof File) || typeof requestId !== 'string')
      throw new ResumeImportHostError('Choose a PDF and try again.');
    if (file.size > RESUME_IMPORT_MAX_BYTES)
      throw new ResumeImportHostError('Choose a PDF of at most 10 MiB.', 413);
    const host = await getResumeImportHost(locals);
    return json(
      await host.receive({
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: file.name,
        requestId,
        ...(form.get('newImport') === 'true' ? { newImport: true } : {}),
      }),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (cause) {
    return resumeImportTransportError(cause);
  }
};
