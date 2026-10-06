import { isHttpError, json, type RequestHandler } from '@sveltejs/kit';
import { getConfiguredPublicOrigin } from '$lib/server/app-config';
import { isOwnerAuthorityDenial } from '$lib/server/owner-principal';
import { runScreeningQuestionAssessment } from '$lib/server/screening-question-assessment-service';
import { ScreeningQuestionStoreError } from '$lib/server/screening-question-store';
import {
  CandidateProfileRequiredError,
  requireCandidateWorkspaceSubject,
  WorkspaceSubjectError,
  workspaceSubjectFromLocals,
} from '$lib/server/workspace-subject';

const headers = { 'Cache-Control': 'private, no-store' };

export const POST: RequestHandler = async ({
  locals,
  request,
  url,
  params,
}) => {
  if (!locals.user)
    return json(
      { error: 'Sign in before running screening.' },
      { status: 401, headers },
    );
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    return json(
      { error: 'Use Run screening from this site.' },
      { status: 415, headers },
    );
  const origin = request.headers.get('origin');
  if (origin && origin !== (getConfiguredPublicOrigin() ?? url.origin))
    return json(
      { error: 'Use Run screening from this site.' },
      { status: 403, headers },
    );
  if (
    !params.id ||
    params.id.length > 200 ||
    Array.from(params.id).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    return json({ error: 'Invalid opportunity.' }, { status: 400, headers });
  let fullReview = false;
  try {
    if (Number(request.headers.get('content-length')) > 512) throw new Error();
    const body = await request.text();
    if (body.length > 512) throw new Error();
    const value: unknown = JSON.parse(body);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'fullReview') ||
      ('fullReview' in value && typeof value.fullReview !== 'boolean')
    )
      throw new Error();
    fullReview = 'fullReview' in value && value.fullReview === true;
  } catch {
    return json(
      { error: 'Run screening accepts no profile or assessment overrides.' },
      { status: 400, headers },
    );
  }
  try {
    const subject = requireCandidateWorkspaceSubject(
      workspaceSubjectFromLocals(locals),
    );
    const result = await runScreeningQuestionAssessment(subject, {
      opportunityId: params.id,
      ...(fullReview ? { fullReview: true } : {}),
    });
    return json({ ok: true, reused: result.reused }, { headers });
  } catch (cause) {
    if (cause instanceof CandidateProfileRequiredError)
      return json(
        { error: 'Candidate profile required.' },
        { status: 409, headers },
      );
    if (cause instanceof WorkspaceSubjectError || isOwnerAuthorityDenial(cause))
      return json(
        { error: 'You do not have permission to screen this opportunity.' },
        { status: 403, headers },
      );
    if (cause instanceof ScreeningQuestionStoreError)
      return json({ error: cause.message }, { status: cause.status, headers });
    if (isHttpError(cause))
      return json(
        { error: cause.body.message },
        { status: cause.status, headers },
      );
    return json(
      {
        error:
          'Screening could not complete. Check the active questions and captured source, then retry.',
      },
      { status: 503, headers },
    );
  }
};
