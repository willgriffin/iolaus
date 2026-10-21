import { json, type RequestHandler } from '@sveltejs/kit';
import { getResumeImportHost } from '$lib/server/resume-import-runtime';
import {
  resumeImportTransportError,
  resumeImportTransportGuard,
} from '$lib/server/resume-import-transport';
export const GET: RequestHandler = async ({ locals, request, url, params }) => {
  const denied = resumeImportTransportGuard(request, url, Boolean(locals.user));
  if (denied) return denied;
  try {
    const host = await getResumeImportHost(locals);
    return json(await host.get(params.id ?? ''), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (cause) {
    return resumeImportTransportError(cause);
  }
};
export const DELETE: RequestHandler = async ({
  locals,
  request,
  url,
  params,
}) => {
  const denied = resumeImportTransportGuard(request, url, Boolean(locals.user));
  if (denied) return denied;
  try {
    await (await getResumeImportHost(locals)).delete(params.id ?? '');
    return new Response(null, { status: 204 });
  } catch (cause) {
    return resumeImportTransportError(cause);
  }
};
