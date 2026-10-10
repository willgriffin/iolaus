import { json, type RequestHandler } from '@sveltejs/kit';
import { shortlistMutationSchema, type ShortlistMutation } from '$lib/shortlist-contract.js';
import {
  listShortlist,
  mutateShortlist,
} from '$lib/server/shortlist-service.js';
import { isOwnerAuthorityDenial, OwnerPrincipalError } from '$lib/server/owner-principal.js';
import { ShortlistStoreError } from '$lib/server/shortlist-store.js';
import { WorkspaceSubjectError } from '$lib/server/workspace-subject.js';
import { readBoundedJsonBody } from '$lib/server/shortlist-http.js';

const headers = { 'Cache-Control': 'private, no-store' };
function failure(cause: unknown): Response {
  if (cause instanceof OwnerPrincipalError) return json({ error: 'Unauthorized' }, { status: 401, headers });
  if (cause instanceof WorkspaceSubjectError || isOwnerAuthorityDenial(cause)) return json({ error: 'Forbidden' }, { status: 403, headers });
  if (cause instanceof ShortlistStoreError) return json({ error: cause.message, ...(cause.entry ? { entry: cause.entry } : {}) }, { status: cause.code === 'conflict' || cause.code === 'receipt_conflict' ? 409 : 422, headers });
  return json({ error: 'Shortlist is temporarily unavailable.' }, { status: 503, headers });
}
function sameOrigin(request: Request, origin: string): boolean {
  const supplied = request.headers.get('origin');
  return supplied === origin;
}
export const GET: RequestHandler = async ({ locals }) => {
  try { return json({ entries: await listShortlist(locals) }, { headers }); }
  catch (cause) { return failure(cause); }
};
export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    return json({ error: 'Send shortlist changes as JSON.' }, { status: 415, headers });
  if (!sameOrigin(request, url.origin))
    return json({ error: 'Use the shortlist from this site.' }, { status: 403, headers });
  let raw: string;
  try { raw = await readBoundedJsonBody(request, 4096); }
  catch { return json({ error: 'Shortlist change is too large.' }, { status: 413, headers }); }
  let mutation: ShortlistMutation;
  try { mutation = shortlistMutationSchema.parse(JSON.parse(raw)); }
  catch { return json({ error: 'Invalid shortlist change.' }, { status: 400, headers }); }
  try { return json({ entry: await mutateShortlist(locals, mutation) }, { headers }); }
  catch (cause) { return failure(cause); }
};
