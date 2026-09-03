// Ashby adapter for the ATS auto-submit feature.
//
// Unlike Greenhouse, Ashby has no documented *unauthenticated* API that returns
// an application form's required-question schema: the public posting API
// (api.ashbyhq.com/posting-api/job-board/{name}) carries posting metadata only,
// and the documented schema endpoint (jobPosting.info) requires the employer's
// API key, which we do not hold for arbitrary employers.
//
// The required-question schema is, however, served unauthenticated by Ashby's
// own hosted board: the posting page embeds the complete application form
// definition in its SSR payload (`window.__appData`), the same public board
// data their frontend hydrates from. We read that:
//   GET https://jobs.ashbyhq.com/{board}/{jobId}
//   → window.__appData.posting.applicationForm.formDefinition.sections[].fields[]
// (We do NOT use the board's internal `non-user-graphql` endpoint: its
// `applicationForm` field is a `FormRender` type that does not expose the form
// definition, so replaying it would mean maintaining a reverse-engineered
// selection set against an undocumented schema. The embedded SSR payload is the
// same source, fully formed, and mirrors how opportunity-source-crawler already
// reads `jobPostings` from the board page.)
//
// The live POST is intentionally a guarded stub: Ashby's certified submission
// path (endpoint + wire format) is not pinned, so it refuses rather than risk a
// real submission. No auth, CAPTCHA, or 2FA is ever bypassed. Only the dry-run
// (build + persist the payload) path is exercised today.

import type {
  AtsBuildPayloadInput,
  AtsFetchSchemaInput,
  AtsFormQuestion,
  AtsFormSchema,
  AtsSubmissionPayload,
  AtsSubmitOutcome,
  AtsSubmitter,
  FetchLike,
} from './types.js';

const ASHBY_HOST = 'jobs.ashbyhq.com';

/** ATS question types that carry a file artifact rather than a scalar answer. */
const FILE_QUESTION_TYPES = new Set(['File']);

export function isAshbyFileQuestion(type: string): boolean {
  return FILE_QUESTION_TYPES.has(type);
}

interface AshbyFieldDef {
  id?: unknown;
  path?: unknown;
  title?: unknown;
  humanReadablePath?: unknown;
  type?: unknown;
}

interface AshbyFormField {
  field?: AshbyFieldDef;
  isRequired?: unknown;
}

interface AshbyFormSection {
  fields?: AshbyFormField[];
}

interface AshbyApplicationForm {
  formDefinition?: { sections?: AshbyFormSection[] };
}

export interface AshbyUrlParts {
  boardToken: string;
  jobId: string;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Derive the board slug and job id from an Ashby posting URL. Ashby hosts every
 * board on a single host as `jobs.ashbyhq.com/{board}/{jobId}` (an optional
 * `/application` suffix and query string are ignored). Returns null when either
 * part is missing — never guesses — and strictly rejects any other host.
 */
export function parseAshbyUrl(rawUrl: string): AshbyUrlParts | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // Strict host match — reject lookalikes like `jobs.ashbyhq.com.evil.com`.
  if (url.hostname.toLowerCase() !== ASHBY_HOST) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const boardToken = segments[0] ?? '';
  const jobId = segments[1] ?? '';
  if (!boardToken || !jobId) return null;
  return { boardToken, jobId };
}

/** Canonical posting page that embeds the application form definition. */
function postingPageUrl(parts: AshbyUrlParts): string {
  return `https://${ASHBY_HOST}/${encodeURIComponent(
    parts.boardToken,
  )}/${encodeURIComponent(parts.jobId)}`;
}

/**
 * Extract the first balanced JSON object that follows `marker` in `html`.
 * String-aware brace matcher (handles escapes and braces inside strings).
 * Returns null when the marker or a balanced object is not found. Pure.
 */
function extractJsonObjectAfter(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Pull the application form questions out of an Ashby posting page's embedded
 * SSR payload. Returns the flattened question list, or null when the form
 * definition cannot be located. Pure — no network.
 */
export function extractAshbyQuestions(html: unknown): AtsFormQuestion[] | null {
  const source = typeof html === 'string' ? html : '';
  if (!source) return null;

  const form = extractJsonObjectAfter(
    source,
    '"applicationForm"',
  ) as AshbyApplicationForm | null;
  const sections = form?.formDefinition?.sections;
  if (!Array.isArray(sections)) return null;

  const questions: AtsFormQuestion[] = [];
  for (const section of sections) {
    for (const formField of section.fields ?? []) {
      const def = formField.field ?? {};
      // The `path` is the wire submission key (e.g. `_systemfield_resume` or a
      // custom-field UUID); fall back to the field id only if path is absent.
      const id = stringValue(def.path) || stringValue(def.id);
      if (!id) continue;
      questions.push({
        id,
        label: stringValue(def.title) || stringValue(def.humanReadablePath),
        required: formField.isRequired === true,
        type: stringValue(def.type) || 'String',
      });
    }
  }
  return questions;
}

async function fetchFormSchema(
  input: AtsFetchSchemaInput,
): Promise<AtsFormSchema | null> {
  const parts = parseAshbyUrl(input.applyUrl);
  if (!parts) return null;
  const fetchImpl: FetchLike = input.fetchImpl ?? fetch;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(postingPageUrl(parts), {
      headers: { accept: 'text/html' },
      redirect: 'follow',
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }

  const questions = extractAshbyQuestions(html);
  if (!questions) return null;

  return {
    ats: 'ashby',
    boardToken: parts.boardToken,
    jobId: parts.jobId,
    fetchedAt: new Date().toISOString(),
    questions,
  };
}

function buildSubmissionPayload(
  input: AtsBuildPayloadInput,
): AtsSubmissionPayload {
  const { schema, answers, resume } = input;
  // Audit target only: Ashby's certified live submission endpoint and wire
  // format are not yet pinned (see the live-blocker note below), and submit()
  // refuses, so this never actually receives a POST. It records *where* a real
  // submission would go for the dry-run payload inspection.
  const endpoint = `https://${ASHBY_HOST}/${encodeURIComponent(
    schema.boardToken,
  )}/${encodeURIComponent(schema.jobId)}/application`;

  const fields = schema.questions
    .filter((question) => !isAshbyFileQuestion(question.type))
    .map((question) => ({
      name: question.id,
      value: stringValue(answers[question.id]),
    }));

  return {
    ats: 'ashby',
    method: 'POST',
    endpoint,
    contentType: 'multipart/form-data',
    fields,
    files: [resume],
  };
}

async function submit(): Promise<AtsSubmitOutcome> {
  // Live Ashby submission is not certified. The hosted-board submission path
  // (exact endpoint + wire format) is not pinned, and the documented
  // applicationForm.submit API requires the employer's API key; until a
  // verified end-to-end flow lands we refuse rather than risk a real
  // application.
  return {
    ok: false,
    kind: 'failed',
    reason:
      'Live Ashby submission is not yet enabled. Dry-run builds and persists the payload only.',
  };
}

function matchesUrl(schema: AtsFormSchema, applyUrl: string): boolean {
  const parts = parseAshbyUrl(applyUrl);
  if (!parts) return false;
  return (
    parts.boardToken === stringValue(schema.boardToken) &&
    parts.jobId === stringValue(schema.jobId)
  );
}

export const ashbySubmitter: AtsSubmitter = {
  ats: 'ashby',
  supports(detectionType: string): boolean {
    return stringValue(detectionType).toLowerCase() === 'ashby';
  },
  isFileQuestion: isAshbyFileQuestion,
  matchesUrl,
  fetchFormSchema,
  buildSubmissionPayload,
  submit,
};
