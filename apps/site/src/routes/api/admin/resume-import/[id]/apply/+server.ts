import { json, type RequestHandler } from '@sveltejs/kit';
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
    return json(
      await (await getResumeImportHost(locals)).apply(params.id ?? '', input),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (cause) {
    return resumeImportTransportError(cause);
  }
};
