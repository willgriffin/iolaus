import { error, fail, isHttpError, isRedirect, redirect } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { isOwnerAuthorityDenial } from '$lib/server/owner-principal';
import {
  getPublicProfileManager,
  preparePublicProfile,
  publishPublicProfile,
  unpublishPublicProfile,
} from '$lib/server/public-profile-service';
import { PublicProfileStoreError } from '$lib/server/public-profile-store';
import type { Actions, PageServerLoad } from './$types';

const MAX_HANDLE_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_REVISION = 2_147_483_647;
const MAX_FORM_BYTES = 16 * 1024;
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

async function readForm(request: Request): Promise<Map<string, string>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith(FORM_CONTENT_TYPE))
    error(400, 'Submit this form from the public profile page.');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES)
    error(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Form data is required.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FORM_BYTES) {
      await reader.cancel();
      error(413, 'Request is too large.');
    }
    chunks.push(value);
  }
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(
    Buffer.concat(chunks).toString('utf8'),
  )) {
    if (values.has(name)) error(400, 'Duplicate form fields are not allowed.');
    values.set(name, value);
  }
  return values;
}

function formString(
  form: Map<string, string>,
  name: string,
  max: number,
): string {
  const value = form.get(name) ?? '';
  if (value.length > max) error(400, 'A form field is too long.');
  return value.trim();
}

function formRevision(form: Map<string, string>): number | null {
  const raw = formString(form, 'expectedRevision', 16);
  if (!/^\d+$/u.test(raw)) return null;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) &&
    revision >= 0 &&
    revision <= MAX_REVISION
    ? revision
    : null;
}

function sameOrigin(request: Request, origin: string): void {
  if (request.headers.get('origin') !== origin)
    error(403, 'Invalid request origin.');
}

async function actionFailure(fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (cause) {
    if (isRedirect(cause)) throw cause;
    if (isHttpError(cause))
      return fail(cause.status, { ok: false, error: cause.body.message });
    if (isOwnerAuthorityDenial(cause))
      return fail(403, {
        ok: false,
        error: 'Your access has changed. Refresh and sign in again.',
      });
    if (cause instanceof ZodError)
      return fail(400, {
        ok: false,
        error: 'Check the public profile details and try again.',
      });
    if (cause instanceof PublicProfileStoreError) {
      const status =
        cause.code === 'conflict' || cause.code === 'handle_taken'
          ? 409
          : cause.code === 'limit'
            ? 429
            : cause.code === 'validation'
              ? 400
              : 404;
      return fail(status, { ok: false, error: cause.message });
    }
    return fail(503, {
      ok: false,
      error:
        'Public profile generation is temporarily unavailable. Your published version has not changed; try again.',
    });
  }
}

export const load: PageServerLoad = async ({ locals, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store' });
  return await getPublicProfileManager(locals);
};

export const actions: Actions = {
  prepare: async ({ locals, request, url }) =>
    await actionFailure(async () => {
      sameOrigin(request, url.origin);
      const form = await readForm(request);
      const prepared = await preparePublicProfile(locals, {
        handle: formString(form, 'handle', MAX_HANDLE_LENGTH),
        profileId: formString(form, 'profileId', MAX_ID_LENGTH),
        visibility: {
          contacts: {
            email: form.get('email') === 'on',
            phone: form.get('phone') === 'on',
            location: form.get('location') === 'on',
            links: form.get('links') === 'on',
          },
          sections: {
            education: form.get('education') === 'on',
            experience: form.get('experience') === 'on',
            other: form.get('other') === 'on',
            skills: form.get('skills') === 'on',
          },
        },
      });
      redirect(
        303,
        `/admin/career/public-profile/preview/${encodeURIComponent(prepared.id)}`,
      );
    }),
  publish: async ({ locals, request, url }) =>
    await actionFailure(async () => {
      sameOrigin(request, url.origin);
      const form = await readForm(request);
      const expectedRevision = formRevision(form);
      if (expectedRevision === null)
        return fail(400, {
          ok: false,
          error: 'Your preview is no longer current. Prepare it again.',
        });
      await publishPublicProfile(locals, {
        revisionId: formString(form, 'revisionId', MAX_ID_LENGTH),
        expectedRevision,
      });
      redirect(303, '/admin/career/public-profile?published=1');
    }),
  unpublish: async ({ locals, request, url }) =>
    await actionFailure(async () => {
      sameOrigin(request, url.origin);
      const expectedRevision = formRevision(await readForm(request));
      if (expectedRevision === null)
        return fail(400, {
          ok: false,
          error: 'This page is out of date. Refresh and try again.',
        });
      await unpublishPublicProfile(locals, { expectedRevision });
      redirect(303, '/admin/career/public-profile?unpublished=1');
    }),
};
