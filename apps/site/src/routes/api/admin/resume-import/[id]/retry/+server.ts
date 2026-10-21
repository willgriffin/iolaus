import { json, type RequestHandler } from '@sveltejs/kit';
import { ResumeImportHostError } from '$lib/server/resume-import-host';
import { getResumeImportHost } from '$lib/server/resume-import-runtime';
import {
  readResumeImportJSON,
  resumeImportTransportError,
  resumeImportTransportGuard,
} from '$lib/server/resume-import-transport';
export const POST: RequestHandler = async ({
  locals,
  request,
  url,
  params,
}) => {
  const denied = resumeImportTransportGuard(request, url, Boolean(locals.user));
  if (denied) return denied;
  try {
    const input = await readResumeImportJSON(request);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'requestId') ||
      !('requestId' in input) ||
      typeof input.requestId !== 'string'
    )
      throw new ResumeImportHostError('A stable retry request ID is required.');
    return json(
      await (await getResumeImportHost(locals)).retry(
        params.id ?? '',
        input.requestId,
      ),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (cause) {
    return resumeImportTransportError(cause);
  }
};
