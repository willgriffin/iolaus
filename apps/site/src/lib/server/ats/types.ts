// Shared types for ATS (applicant tracking system) submitters.
//
// One adapter per ATS sits behind this common shape. Adapters are responsible
// for: (1) fetching the application form schema (the list of required
// questions), (2) building the exact wire payload from mapped answers + the
// resume, and (3) performing the live submission. The live POST is gated by a
// feature flag at the job layer; see docs/auto-submit-design.md.

export type FetchLike = typeof fetch;

/** A single required (or optional) question on an ATS application form. */
export interface AtsFormQuestion {
  /** The ATS field id/name used when posting (e.g. `first_name`, `question_4`). */
  id: string;
  label: string;
  required: boolean;
  /** ATS-reported input type, e.g. `input_text`, `textarea`, `multi_value_single_select`. */
  type: string;
}

/** The persisted form schema fetched during packet generation. */
export interface AtsFormSchema {
  ats: string;
  boardToken: string;
  jobId: string;
  /** ISO timestamp of when the schema was fetched. */
  fetchedAt: string;
  questions: AtsFormQuestion[];
}

/** Metadata for a file part (e.g. the resume). Bytes are never serialized. */
export interface AtsFilePart {
  /** Wire field name, e.g. `resume`. */
  fieldName: string;
  filename: string;
  contentType: string;
  byteLength: number;
  /** SHA-256 digest of the exact file bytes resolved for this payload. */
  sha256?: string;
  /** True when the underlying artifact was actually located. */
  present: boolean;
}

/** A scalar form field on the outgoing multipart payload. */
export interface AtsPayloadField {
  name: string;
  value: string;
}

/**
 * The exact wire payload the adapter would POST. This is what gets persisted
 * (as an AgentRun) in dry-run mode for inspection — it deliberately omits file
 * bytes and any secrets.
 */
export interface AtsSubmissionPayload {
  ats: string;
  method: 'POST';
  endpoint: string;
  contentType: 'multipart/form-data';
  fields: AtsPayloadField[];
  files: AtsFilePart[];
}

export type AtsSubmitOutcome =
  | { ok: true; evidenceUrl: string; confirmationId?: string }
  | { ok: false; kind: 'ineligible' | 'failed'; reason: string };

export interface AtsFetchSchemaInput {
  applyUrl: string;
  fetchImpl?: FetchLike;
}

export interface AtsBuildPayloadInput {
  schema: AtsFormSchema;
  /** Structured answers keyed by ATS question id. */
  answers: Record<string, string>;
  resume: AtsFilePart;
}

export interface AtsSubmitter {
  readonly ats: string;
  /** True when this adapter handles the given `detectJobBoard()` type. */
  supports(detectionType: string): boolean;
  /**
   * True when an `AtsFormQuestion.type` denotes a file artifact (e.g. the
   * resume upload) rather than a scalar answer. Such questions are satisfied by
   * the attached resume, never a typed answer, so callers exclude them from the
   * "all required answers present" check. Each ATS names its file type
   * differently (Greenhouse `input_file`, Ashby `File`, Lever `resume`).
   */
  isFileQuestion(type: string): boolean;
  /**
   * True when a persisted schema belongs to the same job as `applyUrl` (e.g.
   * board token + job id match). Guards against a stale schema left over from a
   * previous apply URL building a payload for the wrong job.
   */
  matchesUrl(schema: AtsFormSchema, applyUrl: string): boolean;
  /** Fetch the form schema, or null if it cannot be resolved. */
  fetchFormSchema(input: AtsFetchSchemaInput): Promise<AtsFormSchema | null>;
  /** Build the exact wire payload from mapped answers + resume. Pure. */
  buildSubmissionPayload(input: AtsBuildPayloadInput): AtsSubmissionPayload;
  /** Perform the live submission. May be a guarded stub until certified. */
  submit(
    payload: AtsSubmissionPayload,
    options?: { fetchImpl?: FetchLike },
  ): Promise<AtsSubmitOutcome>;
}
