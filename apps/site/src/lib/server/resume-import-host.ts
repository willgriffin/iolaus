import { createHash, randomUUID } from 'node:crypto';
import type { AssetRuntimeLike } from '@happyvertical/smrt-assets';
import type {
  IntakeEvidenceDTO,
  IntakeFailure,
} from '@happyvertical/smrt-ingestion/dto';
import type {
  IntakeExecutionOptions,
  OperationHandler,
} from '@happyvertical/smrt-ingestion/execution';
import { IngestionService } from '@happyvertical/smrt-ingestion/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  RESUME_IMPORT_MAX_ENTRIES,
  type ResumeImportEntry,
  type ResumeImportProgressStage,
  type ResumeImportView,
} from '$lib/resume-import';
import { RESUME_IMPORT_STRUCTURE_MAX_BYTES } from '$lib/resume-import-structure.js';
import { withResumeImportAccountFence } from './resume-import-account-fence.js';
import {
  applyResumeImportDomain,
  captureResumeImportMatches,
  type ResumeImportApplyInput,
  ResumeImportDomainError,
  type ResumeImportProposal,
  validateResumeImportApply,
  validateResumeImportProposalEntries,
} from './resume-import-domain.js';
import { RESUME_IMPORT_INGESTION_QUEUE } from './resume-import-job-schema.js';
import {
  beginResumeImportWrite,
  resolveResumeImportWrite,
} from './resume-import-write-admission.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

export const RESUME_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_IMPORT_HANDLER = 'iolaus:resume-import.apply';
export const RESUME_IMPORT_JOB_TARGET = {
  objectType: 'ResumeImportJob',
  method: 'process',
} as const;
const VERSION = '1';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const progressStages = [
  'queued',
  'reading_pdf',
  'reading_scan',
  'extracting_details',
  'matching',
  'model_output_limit',
] as const satisfies readonly ResumeImportProgressStage[];

export interface ResumeImportExtractionInput {
  bytes: Uint8Array;
  evidence: IntakeEvidenceDTO;
  authorize(): Promise<void>;
  onProgress?(stage: ResumeImportProgressStage): Promise<void>;
}
export interface ResumeImportExtractionResult {
  entries: ResumeImportEntry[];
  warnings: string[];
  provider: string;
  model: string;
  version: string;
}
export type ExtractResumeImport = (
  input: ResumeImportExtractionInput,
) => Promise<ResumeImportExtractionResult>;
export interface ResumeImportHostOptions {
  db: DatabaseInterface;
  assets: AssetRuntimeLike;
  subject: CandidateWorkspaceSubject;
  /** Fresh native profile.manage resolution and profile ownership using this executor. */
  authorize(input: {
    db: DatabaseInterface;
    operation: string;
  }): Promise<{ permissions: string[] }>;
  extract: ExtractResumeImport;
  /** Qualified registered model with a dedicated, non-public apply method. */
  operationModel: string;
  purgeDerived?(input: { tenantId: string; itemId: string }): Promise<void>;
  now?: () => Date;
  onApplied?(): void;
}
export class ResumeImportHostError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: 'expired_import' | 'proposal_entry_limit',
  ) {
    super(message);
    this.name = 'ResumeImportHostError';
  }
}
const objectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['proposal', 'input'],
  properties: { proposal: { type: 'object' }, input: { type: 'object' } },
};
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['createdIds', 'mergedIds', 'skippedIds'],
  properties: {
    createdIds: { type: 'array', items: { type: 'string' } },
    mergedIds: { type: 'array', items: { type: 'string' } },
    skippedIds: { type: 'array', items: { type: 'string' } },
  },
};
function hash(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : input;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 160 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ResumeImportHostError('Invalid import identifier.');
  return value;
}

function validReviewField(key: string, value: unknown) {
  if (key.length > 40 || typeof value !== 'string') return false;
  if (key === 'bullets') return value.length <= 50_000;
  if (key === 'bulletSections')
    return (
      new TextEncoder().encode(value).byteLength <=
      RESUME_IMPORT_STRUCTURE_MAX_BYTES
    );
  return value.length <= 20_000;
}

export function parseResumeImportApplyInput(
  value: unknown,
): ResumeImportApplyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResumeImportHostError('Invalid review decision.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['revision', 'entries'].includes(key)) ||
    typeof input.revision !== 'string' ||
    !/^[1-9]\d*$/u.test(input.revision) ||
    !Array.isArray(input.entries)
  )
    throw new ResumeImportHostError('Invalid review decision.');
  if (input.entries.length > RESUME_IMPORT_MAX_ENTRIES)
    throw new ResumeImportHostError(
      `A review may contain at most ${RESUME_IMPORT_MAX_ENTRIES} entries.`,
      400,
      'proposal_entry_limit',
    );
  const seen = new Set<string>();
  const entries = input.entries.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new ResumeImportHostError('Invalid review entry.');
    const row = raw as Record<string, unknown>;
    const id = identifier(row.id);
    if (
      seen.has(id) ||
      Object.keys(row).some(
        (key) => !['id', 'action', 'targetId', 'fields'].includes(key),
      ) ||
      !['create', 'merge', 'skip'].includes(String(row.action)) ||
      !row.fields ||
      typeof row.fields !== 'object' ||
      Array.isArray(row.fields)
    )
      throw new ResumeImportHostError('Invalid review entry.');
    seen.add(id);
    if (
      Object.entries(row.fields).some(
        ([key, field]) => !validReviewField(key, field),
      )
    )
      throw new ResumeImportHostError('Invalid review fields.');
    return {
      id,
      action: row.action as 'create' | 'merge' | 'skip',
      ...(row.targetId === undefined
        ? {}
        : { targetId: identifier(row.targetId) }),
      fields: row.fields as Record<string, string>,
    };
  });
  return { revision: input.revision, entries };
}
function args(value: Record<string, unknown>): {
  proposal: ResumeImportProposal;
  input: ResumeImportApplyInput;
} {
  const proposal = value.proposal as ResumeImportProposal;
  if (
    !proposal ||
    typeof proposal.revision !== 'string' ||
    !Array.isArray(proposal.entries)
  )
    throw new ResumeImportHostError('Invalid saved proposal.');
  validateResumeImportProposalEntries(proposal.entries);
  const input = parseResumeImportApplyInput(value.input);
  validateResumeImportApply(proposal, input);
  return { proposal, input };
}
/** Application adapter around native receipts, leases, evidence, review and atomic execution. */
export function createResumeImportHost(options: ResumeImportHostOptions) {
  const { db, subject } = options;
  const scope = {
    tenantId: subject.tenantId,
    actorId: subject.userId,
    confidentialScopeId: subject.profileId,
  };
  const operation = `${options.operationModel}:apply@${VERSION}`;
  const capturedCeiling = {
    principalId: subject.userId,
    permissions: ['workflow.profile.manage', 'resumeimports.apply'],
    handlers: [RESUME_IMPORT_HANDLER],
    operations: [operation],
  };
  const handler: OperationHandler = {
    id: RESUME_IMPORT_HANDLER,
    version: VERSION,
    description:
      'Apply explicitly reviewed resume entries to the owned profile.',
    operation: {
      model: options.operationModel,
      action: 'apply',
      version: VERSION,
    },
    capability: { effect: 'write', idempotent: true, openWorld: false },
    argsSchema: objectSchema,
    resultSchema,
    resultModels: {},
    async preview(value) {
      const parsed = args(value);
      return {
        display: {
          revision: parsed.proposal.revision,
          count: parsed.input.entries.length,
        },
        normalizedArgs: parsed as unknown as Record<string, unknown>,
        targetPreconditions: [],
      };
    },
    async validate(value) {
      args(value);
      return { ok: true };
    },
    execution: {
      kind: 'database',
      async apply(value, context) {
        const parsed = args(value);
        await options.authorize({ db: context.db, operation: 'execute' });
        return {
          ...(await applyResumeImportDomain({
            db: context.db,
            subject,
            ...parsed,
          })),
        };
      },
    },
  };
  const execution: IntakeExecutionOptions = {
    handlers: [handler],
    async authorize(input) {
      const authority = await options.authorize({
        db: input.db,
        operation: input.operation,
      });
      return {
        allowed: true,
        reviewer: true,
        principalId: subject.userId,
        permissions: authority.permissions,
        mutationBoundary: 'serialized',
        policy: [
          {
            version: 'iolaus-resume-v1',
            handlers: [RESUME_IMPORT_HANDLER],
            operations: [operation],
            reviewers: [subject.userId],
            access: [subject.profileId],
            requireReview: true,
            maxAttempts: 3,
            maxBytes: MAX_OUTPUT_BYTES,
            retentionMs: RETENTION_MS,
            approvalMs: 300_000,
          },
          { version: 'owned-tenant-v1' },
          { version: 'private-resume-v1' },
        ],
      };
    },
    async assertTarget() {
      throw new ResumeImportHostError('Unsupported import target.');
    },
  };
  const service = new IngestionService({
    db,
    assets: options.assets,
    scope,
    execution,
    jobTarget: RESUME_IMPORT_JOB_TARGET,
    now: options.now,
    async authorize(input) {
      await options.authorize({ db: input.db, operation: input.operation });
      return true;
    },
    purgeDerived: options.purgeDerived ?? (async () => {}),
  });
  async function latestProgress(
    itemId: string,
    revision: number,
  ): Promise<ResumeImportProgressStage> {
    const result = await db.query(
      `SELECT event.stage FROM intake_dispatches AS dispatch
       JOIN _smrt_jobs AS job ON CAST(job.id AS TEXT)=dispatch.job_id AND job.tenant_id=dispatch.tenant_id
       JOIN _smrt_job_events AS event ON event.job_id=job.id AND event.tenant_id=job.tenant_id
       WHERE dispatch.item_id=? AND dispatch.tenant_id=? AND dispatch.confidential_scope_id=? AND dispatch.revision=?
         AND job.object_type=? AND job.method=? AND job.queue=?
         AND event.stage IN (?, ?, ?, ?, ?, ?)
       ORDER BY event.created_at DESC, event.id DESC LIMIT 1`,
      [
        itemId,
        subject.tenantId,
        subject.profileId,
        revision,
        RESUME_IMPORT_JOB_TARGET.objectType,
        RESUME_IMPORT_JOB_TARGET.method,
        RESUME_IMPORT_INGESTION_QUEUE,
        ...progressStages,
      ],
    );
    const stage = result.rows[0]?.stage;
    return typeof stage === 'string' &&
      progressStages.includes(stage as ResumeImportProgressStage)
      ? (stage as ResumeImportProgressStage)
      : 'queued';
  }
  async function get(itemId: string): Promise<ResumeImportView> {
    const item = await service.getItem(identifier(itemId));
    const evidence = await service.getEvidence(itemId);
    const filename = item.traceId || evidence[0]?.partId || 'Resume.pdf';
    const progress = await latestProgress(itemId, item.analysisRevision);
    const base = {
      id: itemId,
      revision: String(item.analysisRevision),
      filename,
      warnings: [] as string[],
      entries: [] as ResumeImportEntry[],
      ...(progress === 'queued' ? {} : { progress }),
    };
    if (['needs_attention', 'failed'].includes(item.processingState)) {
      // Read only native safe categories after the service authorizes this item.
      const failure = await db.query(
        'SELECT a.safe_error FROM intake_analysis_attempts a JOIN intake_analyses n ON n.current_attempt_id=a.id AND n.tenant_id=a.tenant_id AND n.confidential_scope_id=a.confidential_scope_id WHERE n.item_id=? AND n.tenant_id=? AND n.confidential_scope_id=? AND n.revision=? LIMIT 1',
        itemId,
        subject.tenantId,
        subject.profileId,
        item.analysisRevision,
      );
      const messages: Record<string, string> = {
        unsupported_type:
          'This PDF could not be read. Upload an unlocked PDF with selectable text or a supported scan.',
        limit:
          'The PDF exceeds the page, text, or processing limit. Upload a shorter resume.',
        timeout:
          'Processing timed out. Retry the import or upload a smaller PDF.',
        malformed_output:
          'The AI response could not be validated. Retry the import.',
        authentication:
          'The configured AI provider is unavailable for this account. Contact your administrator.',
        cancelled: 'Processing was cancelled.',
        integrity:
          'The retained PDF could not be verified. Delete this import and upload the original again.',
        unavailable:
          'Resume processing is unavailable. Check PDF worker and AI configuration, then retry.',
      };
      return {
        ...base,
        status: 'failed',
        error:
          progress === 'model_output_limit'
            ? 'The AI response was too long to validate. Retry the import.'
            : (messages[String(failure.rows[0]?.safe_error)] ??
              messages.unavailable),
      };
    }
    if (!['completed', 'partial'].includes(item.processingState))
      return { ...base, status: 'processing' };
    const snapshot = await service.getCompletedAnalysis(itemId);
    const output = snapshot.result.output;
    const entries = (output.entries as ResumeImportEntry[]).map((entry) => ({
      ...entry,
      candidateMatches: entry.candidateMatches?.map(
        ({ id, label, summary }) => ({ id, label, summary }),
      ),
    }));
    const reviews = await service.listReviews(itemId);
    const applied = reviews.actions.some(
      (action) => action.review.state === 'succeeded',
    );
    return {
      ...base,
      status: applied ? 'applied' : 'review',
      entries,
      warnings: output.warnings as string[],
    };
  }
  async function process(
    itemId: string,
    expectedRevision?: number,
    onProgress?: (stage: ResumeImportProgressStage) => Promise<void>,
  ): Promise<ResumeImportView> {
    const item = await service.getItem(identifier(itemId));
    if (expectedRevision && item.analysisRevision > expectedRevision)
      return get(itemId);
    if (['completed', 'partial'].includes(item.processingState))
      return get(itemId);
    const analysis = item.analysisRevision
      ? { revision: item.analysisRevision }
      : await service.analyze(
          itemId,
          { stage: 'resume-import', version: VERSION },
          'initial',
        );
    const lease = await service.claimAnalysis(
      itemId,
      analysis.revision,
      randomUUID(),
    );
    if (!lease) return get(itemId);
    try {
      const evidence = await service.getEvidence(itemId);
      if (evidence.length !== 1)
        throw new ResumeImportHostError('A single PDF is required.');
      const bytes = await service.readEvidence(itemId, evidence[0].id);
      const result = await options.extract({
        bytes,
        evidence: evidence[0],
        authorize: async () => {
          await options.authorize({ db, operation: 'process' });
          await service.getItem(itemId);
        },
        onProgress: async (stage) => await onProgress?.(stage),
      });
      const kindCounts = result.entries.reduce<Record<string, number>>(
        (counts, entry) => {
          counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
          return counts;
        },
        {},
      );
      console.info('Resume import proposal received.', {
        entryCount: result.entries.length,
        kindCounts,
      });
      if (
        !result.entries.length ||
        result.entries.length > RESUME_IMPORT_MAX_ENTRIES
      ) {
        console.warn('Resume import proposal rejected.', {
          reason: !result.entries.length ? 'no_entries' : 'host_entry_limit',
          entryCount: result.entries.length,
          kindCounts,
        });
        throw new ResumeImportHostError(
          !result.entries.length
            ? 'No supported resume entries were found.'
            : `The extracted proposal has more than ${RESUME_IMPORT_MAX_ENTRIES} entries.`,
          400,
          !result.entries.length ? undefined : 'proposal_entry_limit',
        );
      }
      validateResumeImportProposalEntries(
        result.entries.map(({ id, kind, fields, evidence }) => ({
          id,
          kind,
          fields: fields as Record<string, string>,
          ...(evidence ? { evidence } : {}),
        })),
      );
      if (
        result.warnings.some(
          (warning) => typeof warning !== 'string' || warning.length > 2000,
        )
      )
        throw new ResumeImportHostError(
          'No supported resume entries were found.',
        );
      await onProgress?.('matching');
      const matches = await captureResumeImportMatches({
        db,
        subject,
        entries: result.entries,
      });
      const entries = result.entries.map((entry) => ({
        ...entry,
        candidateMatches:
          matches.find((match) => match.id === entry.id)?.candidateMatches ??
          [],
      }));
      await service.completeAnalysis(lease, {
        status: 'completed',
        provider: result.provider,
        model: result.model,
        version: result.version,
        output: { entries, warnings: result.warnings },
        usage: {},
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        cause.name === 'ResumeImportExtractionError' &&
        'diagnostic' in cause &&
        typeof cause.diagnostic === 'string'
      )
        console.warn('Resume import extraction rejected provider output.', {
          category: 'category' in cause ? cause.category : 'unavailable',
          diagnostic: cause.diagnostic,
        });
      if (cause instanceof ResumeImportDomainError)
        console.warn('Resume import proposal rejected.', {
          reason:
            cause.message === 'Invalid calendar date.'
              ? 'invalid_calendar_date'
              : 'proposal_validation',
        });
      const modelOutputLimit =
        cause &&
        typeof cause === 'object' &&
        'category' in cause &&
        cause.category === 'model_output_limit';
      const proposalEntryLimit =
        cause instanceof ResumeImportHostError &&
        cause.code === 'proposal_entry_limit';
      const category =
        cause &&
        typeof cause === 'object' &&
        'category' in cause &&
        [
          'unsupported_type',
          'malformed_output',
          'limit',
          'timeout',
          'unavailable',
          'authentication',
          'cancelled',
          'integrity',
        ].includes(String(cause.category))
          ? (cause.category as IntakeFailure)
          : 'unavailable';
      if (modelOutputLimit) await onProgress?.('model_output_limit');
      await service.failAnalysis(
        lease,
        modelOutputLimit ||
          proposalEntryLimit ||
          cause instanceof ResumeImportDomainError
          ? 'malformed_output'
          : category,
      );
    }
    return get(itemId);
  }
  return {
    service,
    get,
    process,
    async receive(input: {
      bytes: Uint8Array;
      filename: string;
      requestId: string;
      newImport?: boolean;
    }): Promise<ResumeImportView> {
      return await withResumeImportAccountFence(
        options.db,
        subject,
        async () => {
          identifier(input.requestId);
          if (
            !input.bytes.length ||
            input.bytes.length > RESUME_IMPORT_MAX_BYTES
          )
            throw new ResumeImportHostError(
              'Choose a PDF of at most 10 MiB.',
              413,
            );
          if (new TextDecoder().decode(input.bytes.subarray(0, 5)) !== '%PDF-')
            throw new ResumeImportHostError('Choose a valid PDF file.');
          const filename =
            [...input.filename]
              .map((character) =>
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127 ||
                character === '/' ||
                character === '\\'
                  ? '_'
                  : character,
              )
              .join('')
              .slice(0, 160) || 'Resume.pdf';
          const now = options.now?.() ?? new Date();
          const pdfHash = createHash('sha256')
            .update(input.bytes)
            .digest('hex');
          const receiptInput = {
            sourceId: `iolaus-resume-upload:${subject.profileId}`,
            sourceVersion: VERSION,
            deliveryKey: input.newImport
              ? `${pdfHash}:generation:${input.requestId}`
              : pdfHash,
            deliveredAt: now,
            traceId: filename,
            parts: [
              {
                partId: 'Resume.pdf',
                mediaType: 'application/pdf',
                bytes: input.bytes,
              },
            ],
            capturedCeiling: { execution: capturedCeiling },
            retention: {
              version: VERSION,
              expiresAt: new Date(now.getTime() + RETENTION_MS),
              replayUntil: new Date(now.getTime() + RETENTION_MS),
              acceptAfter: new Date(now.getTime() - 60_000),
            },
            limits: {
              maxBytes: RESUME_IMPORT_MAX_BYTES,
              maxParts: 1,
              maxAttempts: 3,
              // Docker extraction (75s), OCR cold wake (120s), and the existing
              // bounded AI interpretation must fit one native analysis lease.
              leaseMs: 360_000,
              maxOutputBytes: MAX_OUTPUT_BYTES,
            },
          };
          const writeId = await beginResumeImportWrite(
            options.db,
            subject,
            receiptInput,
          );
          const receipt = await service.receive(receiptInput);
          // Pinned smrt-ingestion 0.55.19 returns every rejected result and
          // retry/busy before its first preserve() call. This invocation did
          // not start source I/O; another busy invocation keeps its own marker.
          if (
            receipt.kind === 'rejected' ||
            (receipt.kind === 'retry' && receipt.category === 'busy')
          )
            await resolveResumeImportWrite(options.db, subject, writeId);
          if (receipt.kind === 'rejected' && receipt.category === 'expired') {
            throw new ResumeImportHostError(
              'This PDF belongs to a deleted or expired import. Choose Start a new import to upload it again.',
              409,
              'expired_import',
            );
          }
          if (receipt.kind === 'retry')
            throw new ResumeImportHostError(
              'Upload is temporarily unavailable. Retry this upload.',
              503,
            );
          if (receipt.kind === 'rejected')
            throw new ResumeImportHostError(
              'Upload conflicts with a previous request or exceeds its limits.',
              409,
            );
          if (receipt.kind !== 'accepted' && receipt.kind !== 'duplicate')
            throw new ResumeImportHostError(
              'Upload outcome is unresolved. Contact support before account deletion.',
              503,
            );
          // Native receive awaits source persistence and acceptance before returning.
          // Other retries and thrown/unknown outcomes intentionally retain evidence.
          await resolveResumeImportWrite(options.db, subject, writeId);
          // `analyze`/receive persist a dispatch before a worker may claim it.
          // Repair it now so an authorized caller never waits for the periodic
          // recovery loop, while GET remains a pure read.
          await service.repairDispatches();
          // `receive` has durably accepted and dispatched native analysis. Do not
          // run PDF/OCR/AI work in the request; the worker and repair loop own it.
          return await get(receipt.itemId);
        },
      );
    },
    async retry(itemId: string, requestId: string) {
      identifier(requestId);
      const current = await get(itemId);
      if (current.status === 'applied' || current.status === 'review')
        return current;
      if (current.status === 'processing') return current;
      await service.analyze(
        itemId,
        { stage: 'resume-import', version: VERSION },
        `retry:${requestId}`,
      );
      await service.repairDispatches();
      return await get(itemId);
    },
    async apply(itemId: string, raw: unknown) {
      const input = parseResumeImportApplyInput(raw);
      const current = await get(itemId);
      if (current.status === 'applied') return current;
      if (current.status !== 'review' || current.revision !== input.revision)
        throw new ResumeImportHostError(
          'The proposal changed. Reload it before applying.',
          409,
        );
      const snapshot = await service.getCompletedAnalysis(itemId);
      const proposal: ResumeImportProposal = {
        revision: String(snapshot.revision),
        entries: snapshot.result.output
          .entries as ResumeImportProposal['entries'],
      };
      const actionId = await service.createAction(itemId, 'resume-apply', {
        workflow: 'resume-import-v1',
      });
      const existing = (await service.listReviews(itemId)).actions.find(
        (action) => action.review.actionId === actionId,
      );
      const requestId = hash({ itemId, input });
      const review =
        existing?.args &&
        hash(existing.args) === hash({ proposal, input }) &&
        ['waiting_review', 'authorized', 'executing'].includes(
          existing.review.state,
        )
          ? existing.review
          : await service.previewProposal({
              itemId,
              actionId,
              attemptId: snapshot.attemptId,
              expectedRevision: existing?.review.revision ?? 0,
              requestId: `${requestId}:${existing?.review.revision ?? 0}`,
              handlerId: RESUME_IMPORT_HANDLER,
              handlerVersion: VERSION,
              args: { proposal, input },
            });
      if (review.state === 'waiting_review')
        await service.submitDecision({
          actionId,
          expectedRevision: review.revision,
          expectedReviewVersion: review.reviewVersion,
          bindingHash: review.bindingHash,
          requestId: `approve:${requestId}:${review.revision}`,
          decision: 'approve',
        });
      const result = await service.applyAction(actionId);
      if (result.state !== 'succeeded')
        throw new ResumeImportHostError(
          'The reviewed changes could not be applied. Refresh the review before retrying.',
          409,
        );
      options.onApplied?.();
      return get(itemId);
    },
    async delete(itemId: string) {
      await service.expire(identifier(itemId));
    },
    async repair() {
      await service.sweepRetention();
      return service.repairDispatches();
    },
  };
}
export type ResumeImportHost = ReturnType<typeof createResumeImportHost>;
