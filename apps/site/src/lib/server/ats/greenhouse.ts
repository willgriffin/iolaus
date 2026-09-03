// Greenhouse adapter for the ATS auto-submit feature.
//
// Greenhouse exposes job application forms through the public Job Board API.
// The required-question schema is read from
//   GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}?questions=true
// and a completed application is submitted as a multipart POST to
//   POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}
//
// The live POST is intentionally a guarded stub: it requires board ingestion
// credentials and end-to-end certification that we have not done yet, so it
// refuses rather than risk a real submission. Only the dry-run (build + persist
// the payload) path is exercised today.

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

const GREENHOUSE_API_BASE = 'https://boards-api.greenhouse.io/v1/boards';

/** ATS question types that carry a file artifact rather than a scalar answer. */
const FILE_QUESTION_TYPES = new Set(['input_file']);

export function isGreenhouseFileQuestion(type: string): boolean {
  return FILE_QUESTION_TYPES.has(type);
}

interface GreenhouseQuestionField {
  name?: unknown;
  type?: unknown;
}

interface GreenhouseQuestion {
  label?: unknown;
  required?: unknown;
  fields?: GreenhouseQuestionField[];
}

interface GreenhouseJobDetail {
  questions?: GreenhouseQuestion[];
}

export interface GreenhouseUrlParts {
  boardToken: string;
  jobId: string;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Derive the board token and job id from a Greenhouse apply URL. Supports the
 * hosted board form, the job-boards host, and the embedded application form.
 * Returns null when either part cannot be resolved — never guesses.
 */
export function parseGreenhouseUrl(rawUrl: string): GreenhouseUrlParts | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  // Strict host match — reject lookalikes like `evilgreenhouse.io`.
  if (host !== 'greenhouse.io' && !host.endsWith('.greenhouse.io')) return null;

  // Embedded form: ?for=<board>&token=<jobId> (token may also be gh_jid).
  const embedBoard = stringValue(url.searchParams.get('for'));
  const embedJob =
    stringValue(url.searchParams.get('token')) ||
    stringValue(url.searchParams.get('gh_jid'));

  const segments = url.pathname.split('/').filter(Boolean);
  // Hosted: exactly /{board}/jobs/{id}; never infer a board from malformed paths.
  const isHostedJobPath = segments.length === 3 && segments[1] === 'jobs';
  const pathBoard = isHostedJobPath ? segments[0] : '';
  const hostedBoard =
    (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') &&
    segments.length === 1
      ? stringValue(segments[0])
      : '';
  const pathJob = isHostedJobPath ? segments[2] : '';

  // Subdomain board form: {board}.greenhouse.io/...
  const subdomain = host.endsWith('.greenhouse.io')
    ? host.slice(0, -'.greenhouse.io'.length)
    : '';
  const subdomainBoard =
    subdomain && subdomain !== 'boards' && subdomain !== 'boards-api'
      ? subdomain
      : '';

  const boardToken = embedBoard || pathBoard || hostedBoard || subdomainBoard;
  const jobId = embedJob || pathJob;
  if (!boardToken || !jobId) return null;
  return { boardToken, jobId };
}

function mapQuestions(detail: GreenhouseJobDetail): AtsFormQuestion[] {
  const questions: AtsFormQuestion[] = [];
  for (const question of detail.questions ?? []) {
    const label = stringValue(question.label);
    const required = question.required === true;
    for (const fieldDef of question.fields ?? []) {
      const id = stringValue(fieldDef.name);
      if (!id) continue;
      questions.push({
        id,
        label,
        required,
        type: stringValue(fieldDef.type) || 'input_text',
      });
    }
  }
  return questions;
}

async function fetchFormSchema(
  input: AtsFetchSchemaInput,
): Promise<AtsFormSchema | null> {
  const parts = parseGreenhouseUrl(input.applyUrl);
  if (!parts) return null;
  const fetchImpl: FetchLike = input.fetchImpl ?? fetch;
  const endpoint = `${GREENHOUSE_API_BASE}/${encodeURIComponent(
    parts.boardToken,
  )}/jobs/${encodeURIComponent(parts.jobId)}?questions=true`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(endpoint);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let detail: GreenhouseJobDetail;
  try {
    detail = (await response.json()) as GreenhouseJobDetail;
  } catch {
    return null;
  }

  return {
    ats: 'greenhouse',
    boardToken: parts.boardToken,
    jobId: parts.jobId,
    fetchedAt: new Date().toISOString(),
    questions: mapQuestions(detail),
  };
}

function buildSubmissionPayload(
  input: AtsBuildPayloadInput,
): AtsSubmissionPayload {
  const { schema, answers, resume } = input;
  const endpoint = `${GREENHOUSE_API_BASE}/${encodeURIComponent(
    schema.boardToken,
  )}/jobs/${encodeURIComponent(schema.jobId)}`;

  const fields = schema.questions
    .filter((question) => !isGreenhouseFileQuestion(question.type))
    .map((question) => ({
      name: question.id,
      value: stringValue(answers[question.id]),
    }));

  return {
    ats: 'greenhouse',
    method: 'POST',
    endpoint,
    contentType: 'multipart/form-data',
    fields,
    files: [resume],
  };
}

async function submit(): Promise<AtsSubmitOutcome> {
  // Live Greenhouse submission is not certified. The Job Board ingestion POST
  // requires board credentials and a verified end-to-end flow; until that lands
  // we refuse rather than risk sending a real application.
  return {
    ok: false,
    kind: 'failed',
    reason:
      'Live Greenhouse submission is not yet enabled. Dry-run builds and persists the payload only.',
  };
}

function matchesUrl(schema: AtsFormSchema, applyUrl: string): boolean {
  const parts = parseGreenhouseUrl(applyUrl);
  if (!parts) return false;
  return (
    parts.boardToken === stringValue(schema.boardToken) &&
    parts.jobId === stringValue(schema.jobId)
  );
}

export const greenhouseSubmitter: AtsSubmitter = {
  ats: 'greenhouse',
  supports(detectionType: string): boolean {
    return stringValue(detectionType).toLowerCase() === 'greenhouse';
  },
  isFileQuestion: isGreenhouseFileQuestion,
  matchesUrl,
  fetchFormSchema,
  buildSubmissionPayload,
  submit,
};
