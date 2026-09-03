// Lever adapter for the ATS auto-submit feature.
//
// Lever's public postings API (api.lever.co/v0/postings/{site}/{id}?mode=json)
// is unauthenticated but carries posting metadata only — it does NOT expose the
// application form's questions (verified: no question fields across a live
// board's postings). The required-question schema lives only in the rendered
// apply page, so we read it there:
//   GET https://jobs.lever.co/{site}/{jobId}/apply
//   → each `<li class="application-question …">` block carries one field:
//     a label (`.application-label`), a required marker
//     (`<span class="required">`), and the wire field `name` (e.g. `name`,
//     `email`, `resume`, or `surveysResponses[<id>][responses][fieldN]` for
//     custom questions).
//
// This HTML parse is necessarily more brittle than Greenhouse's JSON API or
// Ashby's embedded JSON: a structural change to the apply page degrades to a
// parse miss, which (like every other miss here) returns null and falls back to
// manual submission — it never builds a payload for the wrong job.
//
// The live POST is intentionally a guarded stub: Lever's certified submission
// path is not pinned, so it refuses rather than risk a real submission. No
// auth/CAPTCHA/2FA is ever bypassed. Only the dry-run (build + persist the
// payload) path is exercised today.

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

const LEVER_HOST = 'jobs.lever.co';

/** ATS question types that carry a file artifact rather than a scalar answer. */
const FILE_QUESTION_TYPES = new Set(['resume']);

export function isLeverFileQuestion(type: string): boolean {
  return FILE_QUESTION_TYPES.has(type);
}

export interface LeverUrlParts {
  boardToken: string;
  jobId: string;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Derive the board slug and job id from a Lever apply/hosted URL. Lever hosts
 * every board on a single host as `jobs.lever.co/{site}/{jobId}` (an optional
 * `/apply` suffix and query string are ignored). Returns null when either part
 * is missing — never guesses — and strictly rejects any other host.
 */
export function parseLeverUrl(rawUrl: string): LeverUrlParts | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // Strict host match — reject lookalikes like `jobs.lever.co.evil.com`.
  if (url.hostname.toLowerCase() !== LEVER_HOST) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  const boardToken = segments[0] ?? '';
  const jobId = segments[1] ?? '';
  if (!boardToken || !jobId) return null;
  return { boardToken, jobId };
}

/** Canonical apply page that renders the application form. */
function applyPageUrl(parts: LeverUrlParts): string {
  return `https://${LEVER_HOST}/${encodeURIComponent(
    parts.boardToken,
  )}/${encodeURIComponent(parts.jobId)}/apply`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const QUESTION_BLOCK_RE = /<li class="application-question([^"]*)"/g;
const LABEL_RE = /class="application-label[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const FIELD_NAME_RE = /<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/i;

function questionLabel(block: string): string {
  const match = block.match(LABEL_RE);
  if (!match) return '';
  // Strip nested markup (incl. the required-✱ span) and normalize whitespace.
  return decodeEntities(match[1].replace(/<[^>]+>/g, ''))
    .replace(/✱/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the application form questions out of a Lever apply page. Segments the
 * page by the `application-question` block start marker (not by `</li>`, which
 * is unreliable — checkbox/multi-select blocks nest their own `<li>`s), then
 * reads one field per block. Returns the flattened question list, or null when
 * no question blocks are present. Pure — no network.
 */
export function extractLeverQuestions(html: unknown): AtsFormQuestion[] | null {
  const source = typeof html === 'string' ? html : '';
  if (!source) return null;

  // Collect block start offsets and their type modifier (e.g. `resume`).
  const starts = [...source.matchAll(QUESTION_BLOCK_RE)].map((match) => ({
    index: match.index ?? 0,
    type: match[1].trim(),
  }));
  if (starts.length === 0) return null;

  const questions: AtsFormQuestion[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i].index;
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length;
    const block = source.slice(start, end);

    const nameMatch = block.match(FIELD_NAME_RE);
    const id = nameMatch ? stringValue(nameMatch[1]) : '';
    if (!id) continue;

    questions.push({
      id,
      label: questionLabel(block),
      // A `required` marker (`<span class="required">`) inside this block.
      required: /class="required"/.test(block),
      type: starts[i].type || 'text',
    });
  }
  return questions;
}

async function fetchFormSchema(
  input: AtsFetchSchemaInput,
): Promise<AtsFormSchema | null> {
  const parts = parseLeverUrl(input.applyUrl);
  if (!parts) return null;
  const fetchImpl: FetchLike = input.fetchImpl ?? fetch;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(applyPageUrl(parts), {
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

  const questions = extractLeverQuestions(html);
  if (!questions) return null;

  return {
    ats: 'lever',
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
  // Audit target only: Lever's certified live submission endpoint and wire
  // format are not pinned (a live-blocker), and submit() refuses, so this never
  // actually receives a POST. It records *where* a real submission would go for
  // the dry-run payload inspection.
  const endpoint = `https://${LEVER_HOST}/${encodeURIComponent(
    schema.boardToken,
  )}/${encodeURIComponent(schema.jobId)}/apply`;

  const fields = schema.questions
    .filter((question) => !isLeverFileQuestion(question.type))
    .map((question) => ({
      name: question.id,
      value: stringValue(answers[question.id]),
    }));

  return {
    ats: 'lever',
    method: 'POST',
    endpoint,
    contentType: 'multipart/form-data',
    fields,
    files: [resume],
  };
}

async function submit(): Promise<AtsSubmitOutcome> {
  // Live Lever submission is not certified. The apply submission path (exact
  // endpoint + wire format, incl. file upload semantics) is not pinned; until a
  // verified end-to-end flow lands we refuse rather than risk a real
  // application.
  return {
    ok: false,
    kind: 'failed',
    reason:
      'Live Lever submission is not yet enabled. Dry-run builds and persists the payload only.',
  };
}

function matchesUrl(schema: AtsFormSchema, applyUrl: string): boolean {
  const parts = parseLeverUrl(applyUrl);
  if (!parts) return false;
  return (
    parts.boardToken === stringValue(schema.boardToken) &&
    parts.jobId === stringValue(schema.jobId)
  );
}

export const leverSubmitter: AtsSubmitter = {
  ats: 'lever',
  supports(detectionType: string): boolean {
    return stringValue(detectionType).toLowerCase() === 'lever';
  },
  isFileQuestion: isLeverFileQuestion,
  matchesUrl,
  fetchFormSchema,
  buildSubmissionPayload,
  submit,
};
