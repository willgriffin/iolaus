import { json, type RequestHandler } from '@sveltejs/kit';
import { shortlistImportSchema, type ShortlistEntry } from '$lib/shortlist-contract.js';
import { importShortlist } from '$lib/server/shortlist-service.js';
import { WorkspaceSubjectError } from '$lib/server/workspace-subject.js';
import { isOwnerAuthorityDenial, OwnerPrincipalError } from '$lib/server/owner-principal.js';
import { ShortlistStoreError } from '$lib/server/shortlist-store.js';
import { readBoundedJsonBody } from '$lib/server/shortlist-http.js';

const headers = { 'Cache-Control': 'private, no-store' };
export const POST: RequestHandler = async ({ locals, request, url }) => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return json({ error: 'Send shortlist entries as JSON.' }, { status: 415, headers });
  const origin = request.headers.get('origin');
  if (origin !== url.origin) return json({ error: 'Use the shortlist from this site.' }, { status: 403, headers });
  let raw: string;
  try { raw = await readBoundedJsonBody(request, 1_000_000); }
  catch { return json({ error: 'Shortlist import is too large.' }, { status: 413, headers }); }
  let entries: ShortlistEntry[];
  try { entries = shortlistImportSchema.parse(JSON.parse(raw)).entries; }
  catch { return json({ error: 'Invalid shortlist import.' }, { status: 400, headers }); }
  try { return json(await importShortlist(locals, entries), { headers }); }
  catch (cause) {
    if (cause instanceof OwnerPrincipalError) return json({ error: 'Unauthorized' }, { status: 401, headers });
    if (cause instanceof WorkspaceSubjectError || isOwnerAuthorityDenial(cause)) return json({ error: 'Forbidden' }, { status: 403, headers });
    if (cause instanceof ShortlistStoreError) return json({ error: cause.message }, { status: cause.code === 'limit' ? 422 : 409, headers });
    return json({ error: 'Shortlist import is temporarily unavailable.' }, { status: 503, headers });
  }
};
