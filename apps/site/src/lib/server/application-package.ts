import { randomUUID } from 'node:crypto';
import type { AIMessage, ChatOptions } from '@happyvertical/ai';
import {
  FactEvidenceCollection,
  FactSubjectCollection,
} from '@happyvertical/smrt-facts';
import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import type { TailoringConfig } from '@willgriffin/iolaus-resume';
import { renderSafeMarkdown } from '../markdown-preview.js';
import {
  applicationApprovalScopeChanged,
  applicationApprovalScopeKeys,
  applicationApprovalShouldInvalidate,
  applicationMaterialsAreLockedOrLeased,
  clearApplicationApprovalFields,
} from '../objects/application-approval-scope.js';
import {
  normalizeApplicationStatus,
  toOpportunityStatus,
} from '../objects/lifecycle.js';
import { resolveWritingAiProfileClient } from './ai-config.js';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import {
  archiveApplicationsForClosedPosting,
  assertOpportunityLifecycleLockIsActive,
  recordAgentAudit,
  runOpportunityLifecycleTransaction,
  runWithFreshPostingPreflight,
  syncApplicationWorkflowTasks,
} from './application-workflow.js';
import { isAtsFileQuestion, parseAtsFormSchema } from './ats/index.js';
import { parseRequiredAnswers } from './auto-submit-eligibility.js';
import {
  getPublishedResumeAsset,
  getResumeTailoringConfig,
  type ResumeRecord,
} from './resume-data.js';
import { getResumeFilesystem } from './resume-files.js';
import { commitResumeVariantIfCurrent } from './resume-variant-concurrency.js';
import { getCollection, getRequestScopedSmrtOptions } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  /**
   * `expectedUpdatedAt` pins the write to a revision the caller resolved
   * earlier; omitted, SMRT guards with the revision the load carried.
   */
  save: (options?: { expectedUpdatedAt?: Date | string }) => Promise<void>;
};

const MATERIAL_PDF_LAUNCH_TIMEOUT_MS = 120_000;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nullableDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeApplicationMode(
  value: unknown,
  allowed: readonly string[],
  fallback: string,
  label: string,
): string {
  const mode = stringValue(value) || fallback;
  if (!allowed.includes(mode)) {
    error(400, `Invalid ${label}.`);
  }
  return mode;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function materialPdfBasename(prefix: string, title: string, fallback: string) {
  const slug = slugify(title) || fallback;
  return `${prefix}-${slug}.pdf`;
}

function applicationMaterialHtml(title: string, markdown: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    @page { size: Letter; margin: 0.65in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #171717;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 18px 0 8px;
      color: #111;
      line-height: 1.2;
    }
    h1 { margin-top: 0; font-size: 22px; }
    h2 { font-size: 16px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
    h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0; }
    p, ul, ol, blockquote, pre { margin: 0 0 10px; }
    ul, ol { padding-left: 20px; }
    li + li { margin-top: 4px; }
    a { color: #0f5d9f; text-decoration: underline; }
    code {
      padding: 1px 3px;
      border-radius: 3px;
      background: #f2f2f2;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    pre {
      overflow: hidden;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #f7f7f7;
      white-space: pre-wrap;
    }
    blockquote {
      padding-left: 10px;
      border-left: 3px solid #ccc;
      color: #555;
    }
  </style>
</head>
<body>${renderSafeMarkdown(markdown)}</body>
</html>`;
}

async function writeMaterialArtifacts(options: {
  basePath: string;
  markdown: string;
  pdfBasename: string;
  title: string;
}) {
  const filesystem = await getResumeFilesystem();
  const markdownPath = `${options.basePath}.md`;
  const textPath = `${options.basePath}.txt`;
  const htmlPath = `${options.basePath}.html`;
  const pdfPath = `${options.basePath}.pdf`;
  const html = applicationMaterialHtml(options.title, options.markdown);

  await Promise.all([
    filesystem.write(markdownPath, options.markdown, { createParents: true }),
    filesystem.write(textPath, options.markdown, { createParents: true }),
    filesystem.write(htmlPath, html, { createParents: true }),
  ]);

  const { renderHtmlToPdf } = await import('@happyvertical/pdf');
  const pdf = await renderHtmlToPdf(html, {
    format: 'Letter',
    margin: {
      top: '0.65in',
      bottom: '0.65in',
      left: '0.65in',
      right: '0.65in',
    },
    launchTimeoutMs: MATERIAL_PDF_LAUNCH_TIMEOUT_MS,
  });
  await filesystem.write(pdfPath, Buffer.from(pdf), { createParents: true });

  return {
    htmlPath,
    markdownPath,
    pdfBasename: options.pdfBasename,
    pdfPath,
    textPath,
  };
}

type MaterialArtifactPaths = {
  htmlPath?: unknown;
  markdownPath?: unknown;
  pdfPath?: unknown;
  textPath?: unknown;
};

async function deleteMaterialArtifactFiles(
  artifacts: MaterialArtifactPaths,
): Promise<void> {
  const filesystem = await getResumeFilesystem();
  await Promise.all(
    [
      artifacts.htmlPath,
      artifacts.markdownPath,
      artifacts.pdfPath,
      artifacts.textPath,
    ]
      .map(stringValue)
      .filter(Boolean)
      .map(async (path) => {
        try {
          await filesystem.delete(path);
        } catch {
          // The primary lifecycle error remains actionable; cleanup is best-effort.
        }
      }),
  );
}

async function deleteGeneratedResumeAsset(asset: MutableRecord): Promise<void> {
  const assetId = stringValue(asset.id);
  if (!assetId) return;
  try {
    const assets = await getCollection('ResumeAsset');
    await assets.delete(assetId);
  } catch {
    // A lost lock is still the actionable error if compensating cleanup fails.
  }
}

async function assertMaterialArtifactWriteAllowed(
  artifacts: Awaited<ReturnType<typeof writeMaterialArtifacts>>,
  assertWriteAllowed: () => void,
): Promise<void> {
  try {
    assertWriteAllowed();
  } catch (cause) {
    // These paths were created only for the current uncommitted artifact. If
    // the lifecycle lock disappeared during rendering, remove them so a later
    // closed-posting transition cannot leave user-visible orphaned materials.
    await deleteMaterialArtifactFiles(artifacts);
    throw cause;
  }
}

async function assertPersistedMaterialAssetWriteAllowed(options: {
  artifactPaths: MaterialArtifactPaths;
  asset: MutableRecord;
  assertWriteAllowed: () => void;
}): Promise<void> {
  try {
    options.assertWriteAllowed();
  } catch (cause) {
    await Promise.all([
      deleteGeneratedResumeAsset(options.asset),
      deleteMaterialArtifactFiles(options.artifactPaths),
    ]);
    throw cause;
  }
}

type MaterialGenerationCleanupLedger = {
  assets: MutableRecord[];
  artifactPaths: MaterialArtifactPaths[];
  newResumeVariants: MutableRecord[];
};

function createMaterialGenerationCleanupLedger(): MaterialGenerationCleanupLedger {
  return {
    artifactPaths: [],
    assets: [],
    newResumeVariants: [],
  };
}

function trackGeneratedMaterialAsset(
  ledger: MaterialGenerationCleanupLedger,
  asset: MutableRecord,
): void {
  ledger.assets.push(asset);
  ledger.artifactPaths.push(asset as MaterialArtifactPaths);
}

function trackNewResumeVariant(
  ledger: MaterialGenerationCleanupLedger,
  variant: MutableRecord,
): void {
  ledger.newResumeVariants.push(variant);
}

/**
 * Generated assets are persisted outside the final application transaction so
 * their file paths can be bound to it. If any later lifecycle check fails,
 * remove every artifact created by this attempt, not only the most recent
 * one. The records and paths are unique to this generation request.
 */
async function cleanupMaterialGenerationAttempt(
  ledger: MaterialGenerationCleanupLedger,
): Promise<void> {
  const assetIds = new Set<string>();
  const variantIds = new Set<string>();
  await Promise.all([
    ...ledger.assets.map(async (asset) => {
      const assetId = stringValue(asset.id);
      if (!assetId || assetIds.has(assetId)) return;
      assetIds.add(assetId);
      await deleteGeneratedResumeAsset(asset);
    }),
    ...ledger.artifactPaths.map((paths) => deleteMaterialArtifactFiles(paths)),
    ...ledger.newResumeVariants.map(async (variant) => {
      const variantId = stringValue(variant.id);
      if (!variantId || variantIds.has(variantId)) return;
      variantIds.add(variantId);
      try {
        const variants = await getCollection('ResumeVariant');
        await variants.delete(variantId);
      } catch {
        // The generation failure remains actionable if cleanup also fails.
      }
    }),
  ]);
}

function textList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.map(stringValue)
    : stringValue(value).split(/\r?\n/);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of values.map((entry) => entry.trim()).filter(Boolean)) {
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function assignListOverride<K extends keyof TailoringConfig>(
  config: TailoringConfig,
  key: K,
  value: unknown,
): void {
  const list = textList(value);
  if (list.length) {
    (config as Record<string, unknown>)[key] = list;
  }
}

function defaultResumeVariantName(opportunity: MutableRecord): string {
  const title = stringValue(opportunity.title);
  return title ? `${title} resume variant` : 'Resume variant';
}

function defaultResumeVariantSlug(opportunity: MutableRecord): string {
  return slugify(
    [opportunity.title, opportunity.companyId].map(stringValue).join(' '),
  );
}

function tailoringPathForSlug(slug: string): string {
  return slug ? `var/tailoring/${slug}.json` : '';
}

function applyResumeVariantOverrides(
  config: TailoringConfig,
  variant: MutableRecord,
): TailoringConfig {
  const name = stringValue(variant.name);
  const outputSlug = stringValue(variant.outputSlug);
  const title = stringValue(variant.titleOverride);
  const summary = stringValue(variant.summaryOverride);

  if (name) config.name = name;
  if (outputSlug) config.outputSlug = outputSlug;
  if (title) config.title = title;
  if (summary) config.summary = summary;
  assignListOverride(config, 'emphasizeTags', variant.emphasizeTags);
  assignListOverride(config, 'excludeTags', variant.excludeTags);
  assignListOverride(config, 'includePositionIds', variant.includePositionIds);
  assignListOverride(config, 'excludePositionIds', variant.excludePositionIds);
  return config;
}

async function tailoringOptionsForResumeVariant(variant: MutableRecord) {
  const tailoringId = stringValue(variant.tailoringConfigId);
  const tailoringRecord = tailoringId
    ? await getResumeTailoringConfig(tailoringId)
    : null;
  if (tailoringId && !tailoringRecord) {
    error(400, 'Resume variant tailoring config not found.');
  }

  const config = applyResumeVariantOverrides(
    { ...(tailoringRecord?.config ?? {}) },
    variant,
  );
  const configSlug = stringValue(tailoringRecord?.configSlug);
  const tailoringConfigPath =
    stringValue(variant.tailoringConfigPath) ||
    tailoringPathForSlug(configSlug);

  return {
    tailoring: Object.keys(config).length ? config : undefined,
    tailoringConfigPath,
    tailoringId: tailoringId || stringValue(tailoringRecord?.id),
    tailoringName: stringValue(config.name),
    tailoringSlug: stringValue(config.outputSlug) || configSlug,
  };
}

async function findResumeVariantForApplication(
  application: MutableRecord,
  opportunity: MutableRecord,
): Promise<MutableRecord | null> {
  const collection = await getCollection('ResumeVariant');
  const resumeVariantId = stringValue(application.resumeVariantId);
  if (resumeVariantId) {
    const variant = (await collection.get(
      resumeVariantId,
    )) as unknown as MutableRecord | null;
    if (!variant) {
      error(404, 'Resume variant not found.');
    }
    assertResumeVariantCompatible(variant, application, opportunity);
    return variant;
  }

  const applicationId = stringValue(application.id);
  if (applicationId) {
    const variants = (await collection.list({
      limit: 25,
      orderBy: 'updated_at DESC',
      where: { applicationId },
    })) as unknown as MutableRecord[];
    const variant = variants.find((candidate) =>
      resumeVariantCanAttach(candidate, application, opportunity),
    );
    if (variant) {
      return variant;
    }
  }

  const opportunityId = stringValue(opportunity.id);
  if (!opportunityId) return null;
  const variants = (await collection.list({
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { opportunityId },
  })) as unknown as MutableRecord[];
  return (
    variants.find((variant) =>
      resumeVariantCanAttach(variant, application, opportunity),
    ) ?? null
  );
}

function resumeVariantCanAttach(
  variant: MutableRecord,
  application: MutableRecord,
  opportunity: MutableRecord,
): boolean {
  const applicationId = stringValue(application.id);
  const companyId = stringValue(opportunity.companyId);
  const variantApplicationId = stringValue(variant.applicationId);
  const variantCompanyId = stringValue(variant.companyId);
  const variantOpportunityId = stringValue(variant.opportunityId);

  if (stringValue(variant.status) === 'archived') {
    return false;
  }
  if (
    variantApplicationId &&
    applicationId &&
    variantApplicationId !== applicationId
  ) {
    return false;
  }
  if (
    variantOpportunityId &&
    variantOpportunityId !== stringValue(opportunity.id)
  ) {
    return false;
  }
  if (variantCompanyId && companyId && variantCompanyId !== companyId) {
    return false;
  }
  return true;
}

function assertResumeVariantCompatible(
  variant: MutableRecord,
  application: MutableRecord,
  opportunity: MutableRecord,
): void {
  const applicationId = stringValue(application.id);
  const companyId = stringValue(opportunity.companyId);
  const variantApplicationId = stringValue(variant.applicationId);
  const variantCompanyId = stringValue(variant.companyId);
  const variantOpportunityId = stringValue(variant.opportunityId);

  if (stringValue(variant.status) === 'archived') {
    error(400, 'Resume variant is archived.');
  }
  if (
    variantApplicationId &&
    applicationId &&
    variantApplicationId !== applicationId
  ) {
    error(400, 'Resume variant belongs to another application.');
  }
  if (
    variantOpportunityId &&
    variantOpportunityId !== stringValue(opportunity.id)
  ) {
    error(400, 'Resume variant belongs to another opportunity.');
  }
  if (variantCompanyId && companyId && variantCompanyId !== companyId) {
    error(400, 'Resume variant belongs to another company.');
  }
}

async function getOrCreateResumeVariantForApplication(
  application: MutableRecord,
  opportunity: MutableRecord,
): Promise<{
  persistedState: Record<string, unknown> | null;
  variant: MutableRecord;
}> {
  const collection = await getCollection('ResumeVariant');
  const existing = await findResumeVariantForApplication(
    application,
    opportunity,
  );
  const persistedState = existing ? jsonRecord(existing) : null;
  const variant =
    existing ??
    ((await collection.create({
      status: 'draft',
    })) as unknown as MutableRecord);
  const variantId = stringValue(variant.id);
  const existingOutputSlug = stringValue(variant.outputSlug);
  if (variantId) application.resumeVariantId = variantId;
  Object.assign(variant, {
    applicationId: stringValue(application.id),
    companyId:
      stringValue(opportunity.companyId) || stringValue(variant.companyId),
    name: stringValue(variant.name) || defaultResumeVariantName(opportunity),
    opportunityId: stringValue(opportunity.id),
    outputSlug:
      existingOutputSlug ||
      defaultResumeVariantSlug(opportunity) ||
      stringValue(variant.id),
    status: stringValue(variant.status) || 'draft',
  });
  return { persistedState, variant };
}

function syncResumeVariantArtifact(options: {
  application: MutableRecord;
  asset: ResumeRecord;
  opportunity: MutableRecord;
  tailoringConfigPath: string;
  variant: MutableRecord;
}) {
  const { application, asset, opportunity, tailoringConfigPath, variant } =
    options;
  Object.assign(variant, {
    applicationId: stringValue(application.id),
    companyId:
      stringValue(opportunity.companyId) || stringValue(variant.companyId),
    generatedAt: dateValue(asset.generatedAt) ?? new Date(),
    generatedPath: stringValue(asset.generatedPath),
    htmlPath: stringValue(asset.htmlPath),
    markdownPath: stringValue(asset.markdownPath),
    opportunityId: stringValue(opportunity.id),
    outputSlug:
      stringValue(asset.outputSlug) || stringValue(variant.outputSlug),
    pdfPath: stringValue(asset.pdfPath),
    resumeAssetId: stringValue(asset.id),
    status: 'generated',
    tailoringConfigId:
      stringValue(variant.tailoringConfigId) || stringValue(asset.tailoringId),
    tailoringConfigPath:
      stringValue(variant.tailoringConfigPath) || tailoringConfigPath,
    textPath: stringValue(asset.textPath),
  });
}

function assertMaterialEditable(application: MutableRecord): void {
  if (applicationMaterialsAreLockedOrLeased(application.status, application)) {
    error(
      400,
      'Submitted or closed applications cannot have their approved materials changed.',
    );
  }
}

function assertMaterialGenerationIsAllowed(application: MutableRecord): void {
  assertMaterialEditable(application);
  if (applicationApprovalShouldInvalidate(application.status)) {
    error(
      409,
      'Clear final approval before regenerating application materials.',
    );
  }
}

function materialArtifactBasePath(
  applicationId: string,
  opportunityId: string,
  material: string,
  generatedAt: Date,
): string {
  const ownerId = applicationId || opportunityId || 'application';
  return `application-packages/${ownerId}/${material}-${generatedAt.getTime()}-${randomUUID()}`;
}

function materialAssetIdsFrom(application: MutableRecord) {
  return {
    coverLetterAssetId: stringValue(application.coverLetterAssetId),
    packetAssetId: stringValue(application.packetAssetId),
    resumeAssetId: stringValue(application.resumeAssetId),
    resumeVariantId: stringValue(application.resumeVariantId),
  };
}

function restoreMaterialAssetIds(
  application: MutableRecord,
  materialAssetIds: ReturnType<typeof materialAssetIdsFrom>,
): void {
  for (const [key, value] of Object.entries(materialAssetIds)) {
    if (value) application[key] = value;
  }
}

function restoreMutableRecord(
  record: MutableRecord,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(record)) {
    if (typeof record[key] === 'function') continue;
    if (!Object.hasOwn(snapshot, key)) delete record[key];
  }
  Object.assign(record, snapshot);
}

function shouldMoveOpportunityIntoApplicationWorkflow(
  status: unknown,
): boolean {
  const opportunityStatus = toOpportunityStatus(status);
  return (
    !opportunityStatus ||
    opportunityStatus === 'found' ||
    opportunityStatus === 'recommended'
  );
}

export function normalizeOpportunityRating(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const rating = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    error(400, 'Opportunity rating must be blank or an integer from 1 to 10.');
  }
  return rating;
}

export async function updateOpportunityReview(options: {
  /**
   * The revision the caller resolved this row at. When supplied the write is
   * pinned to it, so a row edited since then fails its compare-and-swap
   * instead of overwriting the newer value. Bulk callers pass it because the
   * gap between resolving a selection and applying to it is wide enough for
   * another writer to land; single-row callers read and write in one step and
   * can rely on the revision the load itself carried.
   */
  expectedUpdatedAt?: Date | string;
  humanRating?: unknown;
  humanReviewNotes?: string;
  humanReviewStatus: string;
  opportunityId: string;
  reviewedByProfileId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const status = stringValue(options.humanReviewStatus);
  if (
    status &&
    !['needs_input', 'maybe', 'apply', 'reject', 'archived'].includes(status)
  ) {
    error(400, 'Invalid opportunity review status.');
  }

  const collection = await getCollection('Opportunity');
  const opportunity = (await collection.get(
    options.opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) {
    error(404, 'Opportunity not found.');
  }

  Object.assign(opportunity, {
    humanRating: normalizeOpportunityRating(options.humanRating),
    humanReviewNotes: stringValue(options.humanReviewNotes),
    humanReviewStatus: status,
    reviewedAt: new Date(),
    reviewedByProfileId: stringValue(options.reviewedByProfileId),
    reviewedByUserId: stringValue(options.user?.id),
  });
  await opportunity.save(
    options.expectedUpdatedAt
      ? { expectedUpdatedAt: options.expectedUpdatedAt }
      : undefined,
  );
  return jsonRecord(opportunity);
}

export async function bulkUpdateOpportunityReviews(options: {
  humanRating?: unknown;
  humanReviewNotes?: string;
  humanReviewStatus: string;
  opportunityIds: string[];
  reviewedByProfileId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const status = stringValue(options.humanReviewStatus);
  if (!status) {
    error(400, 'Bulk review status is required.');
  }

  const opportunityIds = Array.from(
    new Set(options.opportunityIds.map(stringValue).filter(Boolean)),
  );
  if (opportunityIds.length === 0) {
    error(400, 'Select at least one opportunity.');
  }

  const collection = await getCollection('Opportunity');
  const ratingOverride = stringValue(options.humanRating);
  const notesOverride = stringValue(options.humanReviewNotes);
  const reviewedByProfileId = stringValue(options.reviewedByProfileId);
  const records: Record<string, unknown>[] = [];

  for (const opportunityId of opportunityIds) {
    const opportunity = (await collection.get(
      opportunityId,
    )) as unknown as MutableRecord | null;
    if (!opportunity) {
      error(404, 'Opportunity not found.');
    }

    records.push(
      await updateOpportunityReview({
        humanRating: ratingOverride
          ? options.humanRating
          : opportunity.humanRating,
        humanReviewNotes:
          notesOverride || stringValue(opportunity.humanReviewNotes),
        humanReviewStatus: status,
        opportunityId,
        reviewedByProfileId:
          reviewedByProfileId || stringValue(opportunity.reviewedByProfileId),
        user: options.user,
      }),
    );
  }

  return {
    count: records.length,
    records,
    status: 'updated',
  };
}

export async function createDraftApplicationForOpportunity(options: {
  applicationInstructions?: string;
  applyMethod?: string;
  coverLetterMode?: string;
  dueAt?: unknown;
  opportunityId: string;
  preflightOverrideReason?: string;
  requiredAnswers?: string;
  resumeMode?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const opportunityCollection = await getCollection('Opportunity');
  const opportunity = (await opportunityCollection.get(
    options.opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) {
    error(404, 'Opportunity not found.');
  }

  const coverLetterMode = normalizeApplicationMode(
    options.coverLetterMode,
    ['none', 'generate', 'custom', 'default'],
    'none',
    'cover letter mode',
  );
  const resumeMode = normalizeApplicationMode(
    options.resumeMode,
    ['default', 'generate_tailored', 'custom', 'none'],
    'default',
    'resume mode',
  );
  return await runWithFreshPostingPreflight({
    action: 'create_application_draft',
    onClosed: async () => {
      await archiveApplicationsForClosedPosting(options.opportunityId);
    },
    opportunity,
    overrideReason: options.preflightOverrideReason,
    run: async (currentOpportunity) =>
      await runOpportunityLifecycleTransaction(async (database) => {
        const applicationCollection = await getCollection('Application', {
          db: database,
        });
        const opportunities = await getCollection('Opportunity', {
          db: database,
        });
        const opportunity = (await opportunities.get(
          stringValue(currentOpportunity.id),
        )) as unknown as MutableRecord | null;
        if (!opportunity) error(404, 'Opportunity not found.');
        const existing = (await applicationCollection.list({
          limit: 1,
          orderBy: 'updated_at DESC',
          where: { opportunityId: options.opportunityId },
        })) as unknown as MutableRecord[];
        const existingApplication = existing[0];
        const application =
          existingApplication ??
          ((await applicationCollection.create(
            {},
          )) as unknown as MutableRecord);
        const publishedResume =
          resumeMode === 'default' ? await getPublishedResumeAsset() : null;
        const resumeAssetId =
          resumeMode === 'default'
            ? (publishedResume?.id ?? stringValue(application.resumeAssetId))
            : resumeMode === 'custom'
              ? stringValue(application.resumeAssetId)
              : '';
        const coverLetterAssetId =
          coverLetterMode === 'custom' || coverLetterMode === 'default'
            ? stringValue(application.coverLetterAssetId)
            : '';
        const nextPlanning = {
          applicationInstructions: stringValue(options.applicationInstructions),
          applyMethod: stringValue(options.applyMethod) || 'company_site',
          coverLetterAssetId,
          coverLetterMode,
          dueAt: nullableDate(options.dueAt),
          opportunityId: options.opportunityId,
          requiredAnswers: stringValue(options.requiredAnswers),
          resumeAssetId,
          resumeMode,
          resumeVariantId:
            resumeMode === 'generate_tailored'
              ? stringValue(application.resumeVariantId)
              : '',
        };
        const currentStatus = normalizeApplicationStatus(application.status);
        const scopeChanged = applicationApprovalScopeChanged({
          currentRecord: application,
          payload: nextPlanning,
        });
        if (scopeChanged) {
          assertMaterialEditable(application);
        }

        const updates: Record<string, unknown> = {
          ...nextPlanning,
          status:
            applicationApprovalShouldInvalidate(currentStatus) && scopeChanged
              ? 'awaiting_user'
              : currentStatus === 'draft'
                ? 'application_drafting'
                : currentStatus,
        };
        if (
          applicationApprovalShouldInvalidate(currentStatus) &&
          scopeChanged
        ) {
          clearApplicationApprovalFields(updates);
        }

        if (existingApplication) {
          if (
            !(await commitApplicationIfCurrent(application, updates, database))
          ) {
            error(
              409,
              'Application changed while its planning was updated. Reload and review the current application.',
            );
          }
        } else {
          Object.assign(application, updates);
          await application.save();
        }

        if (shouldMoveOpportunityIntoApplicationWorkflow(opportunity.status)) {
          opportunity.status = 'apply';
          await opportunity.save();
        }

        await syncApplicationWorkflowTasks(application);
        return jsonRecord(application);
      }),
    user: options.user,
  });
}

async function linkedFactSubjects(opportunity: MutableRecord) {
  const subjects: Array<{ entityId: string; entityType: string }> = [];
  const opportunityId = stringValue(opportunity.id);
  const organizationProfileId = stringValue(opportunity.organizationProfileId);

  if (opportunityId) {
    subjects.push({ entityId: opportunityId, entityType: 'Opportunity' });
  }
  if (organizationProfileId) {
    subjects.push({ entityId: organizationProfileId, entityType: 'Profile' });
  }

  const candidateProfiles = (await (
    await getCollection('CandidateProfile')
  ).list({
    limit: 50,
    orderBy: 'updated_at DESC',
  })) as unknown as MutableRecord[];
  const orderedProfiles = candidateProfiles
    .sort(
      (left, right) =>
        Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)),
    )
    .slice(0, 5);
  for (const profile of orderedProfiles) {
    const profileId = stringValue(profile.id);
    if (profileId) {
      subjects.push({ entityId: profileId, entityType: 'CandidateProfile' });
    }
  }

  if (organizationProfileId) {
    const companyResearch = (await (
      await getCollection('CompanyResearch')
    ).list({
      limit: 5,
      where: { organizationProfileId },
    })) as unknown as MutableRecord[];
    for (const research of companyResearch) {
      const researchId = stringValue(research.id);
      if (researchId) {
        subjects.push({ entityId: researchId, entityType: 'CompanyResearch' });
      }
    }
  }

  return subjects;
}

async function factsForApplication(opportunity: MutableRecord) {
  const facts = await getCollection('Fact');
  const smrtOptions = getRequestScopedSmrtOptions();
  const subjects = await FactSubjectCollection.create(smrtOptions);
  const evidences = await FactEvidenceCollection.create(smrtOptions);
  const factIds = new Set<string>();
  const candidateFactIds = new Set<string>();
  for (const subject of await linkedFactSubjects(opportunity)) {
    const links = await subjects.getForEntity(
      subject.entityType,
      subject.entityId,
    );
    for (const link of links) {
      const factId = stringValue(link.factId);
      if (!factId) continue;
      factIds.add(factId);
      if (subject.entityType === 'CandidateProfile') {
        candidateFactIds.add(factId);
      }
    }
  }

  const loadedFacts = (await Promise.all(
    [...factIds].map((factId) => facts.get(factId)),
  )) as unknown as Array<MutableRecord | null>;
  const activeFacts = loadedFacts.filter(
    (fact): fact is MutableRecord =>
      fact !== null && stringValue(fact.status) !== 'superseded',
  );

  return await Promise.all(
    activeFacts.map(async (fact) => ({
      evidence: await evidences.getForFact(stringValue(fact.id)),
      fact,
      isCandidateFact: candidateFactIds.has(stringValue(fact.id)),
    })),
  );
}

type ApplicationFactEntry = Awaited<
  ReturnType<typeof factsForApplication>
>[number];

function verifiedCandidateFactEntries(
  factEntries: ApplicationFactEntry[],
): ApplicationFactEntry[] {
  return factEntries.filter(
    ({ evidence, fact, isCandidateFact }) =>
      isCandidateFact &&
      stringValue(fact.status) === 'active' &&
      evidence.some((entry) => stringValue(entry.status) === 'supports'),
  );
}

function scalarText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value instanceof Date && !Number.isNaN(value.getTime()))
    return value.toISOString();
  return stringValue(value);
}

function addDetail(lines: string[], label: string, value: unknown): void {
  const text = scalarText(value);
  if (text) {
    lines.push(`- ${label}: ${text}`);
  }
}

function rangeText(min: unknown, max: unknown, suffix = ''): string {
  const minText = scalarText(min);
  const maxText = scalarText(max);
  if (minText && maxText) return `${minText}-${maxText}${suffix}`;
  if (minText) return `${minText}${suffix}+`;
  if (maxText) return `up to ${maxText}${suffix}`;
  return '';
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(stringValue).filter(Boolean))];
}

function evidenceSourceUrls(factEntries: ApplicationFactEntry[]): string[] {
  return factEntries.flatMap(({ evidence }) =>
    evidence.flatMap((entry) => {
      const record = entry as unknown as Record<string, unknown>;
      return uniqueStrings([record.sourceUrl, record.url, record.sourceUri]);
    }),
  );
}

async function companyResearchForOpportunity(
  opportunity: MutableRecord,
): Promise<MutableRecord[]> {
  const organizationProfileId = stringValue(opportunity.organizationProfileId);
  if (!organizationProfileId) return [];

  return (await (
    await getCollection('CompanyResearch')
  ).list({
    limit: 5,
    orderBy: 'updated_at DESC',
    where: { organizationProfileId },
  })) as unknown as MutableRecord[];
}

function packetSourceUrls(options: {
  application: MutableRecord;
  companyResearch: MutableRecord[];
  factEntries: ApplicationFactEntry[];
  opportunity: MutableRecord;
}): string[] {
  return uniqueStrings([
    options.opportunity.postingUrl,
    options.opportunity.canonicalUrl,
    options.application.applicationUrl,
    ...options.companyResearch.flatMap((research) => [
      research.websiteUrl,
      research.careersUrl,
      research.linkedinUrl,
      research.crunchbaseUrl,
      research.ycUrl,
    ]),
    ...evidenceSourceUrls(options.factEntries),
  ]);
}

function factLine(
  entry: ApplicationFactEntry,
  index: number,
  qualification: string,
): string {
  const { evidence, fact } = entry;
  const evidenceIds = evidence
    .map((item) => stringValue(item.id))
    .filter(Boolean);
  const factText =
    stringValue(fact.textRefined) ||
    stringValue(fact.textRaw) ||
    stringValue(fact.id);
  const status = stringValue(fact.status) || 'unknown';
  return `${index + 1}. ${factText} [fact:${stringValue(fact.id)}${
    evidenceIds.length ? ` evidence:${evidenceIds.join(',')}` : ''
  }] — ${qualification}; status: ${status}.`;
}

function verifiedCandidateFactLines(
  factEntries: ApplicationFactEntry[],
): string[] {
  if (!factEntries.length) {
    return [
      '- No verified candidate evidence is linked to this opportunity yet.',
    ];
  }

  return factEntries.map((entry, index) =>
    factLine(entry, index, 'verified candidate evidence'),
  );
}

function linkedContextFactLines(
  factEntries: ApplicationFactEntry[],
  verifiedFactIds: Set<string>,
): string[] {
  const unverifiedEntries = factEntries.filter(
    ({ fact }) => !verifiedFactIds.has(stringValue(fact.id)),
  );
  if (!unverifiedEntries.length) {
    return ['- No additional linked context is recorded.'];
  }

  return unverifiedEntries.map((entry, index) =>
    factLine(entry, index, 'linked context only; verify before use'),
  );
}

function buildApplicationPacketMarkdown(options: {
  application: MutableRecord;
  companyResearch: MutableRecord[];
  factEntries: ApplicationFactEntry[];
  generatedAt: Date;
  opportunity: MutableRecord;
  sourceUrls: string[];
}): string {
  const {
    application,
    companyResearch,
    factEntries,
    generatedAt,
    opportunity,
    sourceUrls,
  } = options;
  const applicationId = stringValue(application.id);
  const opportunityId = stringValue(opportunity.id);
  const title =
    stringValue(opportunity.title) || opportunityId || applicationId;
  const verifiedCandidateFacts = verifiedCandidateFactEntries(factEntries);
  const verifiedCandidateFactIds = new Set(
    verifiedCandidateFacts.map(({ fact }) => stringValue(fact.id)),
  );
  const opportunityFacts: string[] = [];
  addDetail(opportunityFacts, 'Title', opportunity.title);
  addDetail(opportunityFacts, 'Opportunity ID', opportunityId);
  addDetail(opportunityFacts, 'Application ID', applicationId);
  addDetail(opportunityFacts, 'Status', opportunity.status);
  addDetail(opportunityFacts, 'Posting URL', opportunity.postingUrl);
  addDetail(opportunityFacts, 'Canonical URL', opportunity.canonicalUrl);
  addDetail(opportunityFacts, 'Employment type', opportunity.employmentType);
  addDetail(opportunityFacts, 'Seniority', opportunity.seniority);
  addDetail(opportunityFacts, 'Work mode', opportunity.workMode);
  addDetail(
    opportunityFacts,
    'Locations',
    opportunity.locations || opportunity.locationNotes,
  );
  addDetail(opportunityFacts, 'Required skills', opportunity.requiredSkills);
  addDetail(opportunityFacts, 'Preferred skills', opportunity.preferredSkills);
  addDetail(opportunityFacts, 'Domain tags', opportunity.domainTags);
  addDetail(opportunityFacts, 'Role tags', opportunity.roleTags);
  addDetail(
    opportunityFacts,
    'Description summary',
    opportunity.descriptionSummary,
  );

  const compensationFacts: string[] = [];
  addDetail(
    compensationFacts,
    'Salary range',
    rangeText(
      opportunity.salaryMin,
      opportunity.salaryMax,
      stringValue(opportunity.currency)
        ? ` ${stringValue(opportunity.currency)}`
        : '',
    ),
  );
  addDetail(
    compensationFacts,
    'Hourly range',
    rangeText(opportunity.hourlyMin, opportunity.hourlyMax),
  );
  addDetail(
    compensationFacts,
    'Equity range',
    rangeText(opportunity.equityMinPercent, opportunity.equityMaxPercent, '%'),
  );
  addDetail(compensationFacts, 'Compensation notes', opportunity.compNotes);
  addDetail(
    compensationFacts,
    'Visa/EOR possible',
    opportunity.visaOrEorPossible,
  );
  addDetail(
    compensationFacts,
    'Relocation supported',
    opportunity.relocationSupported,
  );
  addDetail(compensationFacts, 'Application due at', application.dueAt);

  const researchLines = companyResearch.flatMap((research, index) => {
    const lines = [`### Company research ${index + 1}`];
    addDetail(lines, 'Research ID', research.id);
    addDetail(lines, 'Research status', research.researchStatus);
    addDetail(lines, 'Website', research.websiteUrl);
    addDetail(lines, 'Careers', research.careersUrl);
    addDetail(lines, 'LinkedIn', research.linkedinUrl);
    addDetail(lines, 'Crunchbase', research.crunchbaseUrl);
    addDetail(lines, 'YC', research.ycUrl);
    addDetail(lines, 'Stage', research.stage);
    addDetail(lines, 'Remote policy', research.remotePolicy);
    addDetail(lines, 'Timezone notes', research.timezoneNotes);
    addDetail(lines, 'Funding notes', research.fundingNotes);
    addDetail(lines, 'Product summary', research.productSummary);
    addDetail(lines, 'Technical summary', research.technicalSummary);
    addDetail(lines, 'Why interesting', research.whyInteresting);
    addDetail(lines, 'Concerns', research.concerns);
    return lines;
  });

  const fitRationale: string[] = [];
  addDetail(fitRationale, 'Human review notes', opportunity.humanReviewNotes);
  if (opportunity.greenfieldSignal) {
    fitRationale.push(
      '- Emphasize greenfield execution and turning ambiguous systems into shipped products.',
    );
  }
  if (opportunity.founderSignal) {
    fitRationale.push(
      '- Emphasize founder-grade ownership, direct customer context, and pragmatic delivery.',
    );
  }
  if (stringValue(opportunity.requiredSkills)) {
    fitRationale.push(
      `- Mirror the posting language around: ${stringValue(opportunity.requiredSkills)}.`,
    );
  }
  if (!fitRationale.length) {
    fitRationale.push(
      '- No explicit fit rationale has been recorded yet; review linked facts before submission.',
    );
  }

  const concerns = uniqueStrings([
    opportunity.compNotes,
    ...companyResearch.map((research) => research.concerns),
  ]);
  const openQuestions = [
    'Does the user approve the packet, generated materials, and positioning for this submission?',
  ];
  if (
    !stringValue(opportunity.postingUrl) &&
    !stringValue(opportunity.canonicalUrl)
  ) {
    openQuestions.push(
      'What source URL should be treated as the canonical posting?',
    );
  }
  if (!stringValue(application.applicationUrl)) {
    openQuestions.push(
      'What application URL or platform should be used if this moves to submission?',
    );
  }
  if (!stringValue(application.requiredAnswers)) {
    openQuestions.push(
      'Are there application questions that need drafted answers before approval?',
    );
  }
  if (
    !stringValue(opportunity.locationNotes) &&
    !stringValue(opportunity.locations)
  ) {
    openQuestions.push(
      'Confirm location, timezone, and work-authorization constraints.',
    );
  }

  const draftAnswers = stringValue(application.requiredAnswers)
    ? [
        `Prompts or requirements captured on the application record: ${stringValue(
          application.requiredAnswers,
        )}`,
        'Draft answer status: needs user/Hermes review before use outside the app.',
      ]
    : ['No required application answers are recorded yet.'];

  const atsSchema = parseAtsFormSchema(application.requiredQuestionsJson);
  const structuredAnswers = parseRequiredAnswers(
    application.requiredAnswersJson,
  );
  const atsQuestionLines = !atsSchema
    ? [
        '- No supported ATS form schema was available while this packet was prepared. Verify application questions before submission.',
      ]
    : atsSchema.questions.length === 0
      ? ['- The ATS returned no application questions.']
      : atsSchema.questions.map((question) => {
          const label = stringValue(question.label) || question.id;
          if (isAtsFileQuestion(atsSchema.ats, question.type)) {
            return `- ${question.required ? 'Required' : 'Optional'} file: ${label} — handled separately by the selected application artifact.`;
          }
          const answer = stringValue(structuredAnswers[question.id]);
          if (answer) {
            return `- ${question.required ? 'Required' : 'Optional'}: ${label} — user-provided answer: ${answer}`;
          }
          return question.required
            ? `- Required: ${label} — user input required; do not infer or submit without an answer.`
            : `- Optional: ${label} — no answer recorded.`;
        });

  return [
    `# Application packet - ${title}`,
    '',
    'This packet is an internal review artifact. It does not authorize employer contact, credential use, CAPTCHA/2FA handling, or application submission.',
    '',
    '## Facts',
    '',
    '### Opportunity summary',
    '',
    ...(opportunityFacts.length
      ? opportunityFacts
      : ['- No opportunity details recorded yet.']),
    '',
    '### Company profile / research notes',
    '',
    ...(researchLines.length
      ? researchLines
      : ['- No company research records are linked yet.']),
    '',
    '### Compensation, location, and work authorization',
    '',
    ...(compensationFacts.length
      ? compensationFacts
      : [
          '- No compensation, location, or work-authorization notes are recorded yet.',
        ]),
    '',
    '### Verified candidate evidence',
    '',
    ...verifiedCandidateFactLines(verifiedCandidateFacts),
    '',
    '### Additional linked context (not verified candidate evidence)',
    '',
    ...linkedContextFactLines(factEntries, verifiedCandidateFactIds),
    '',
    '### Generated assets',
    '',
    `- Resume asset: ${stringValue(application.resumeAssetId) || 'not selected'}`,
    `- Resume variant: ${stringValue(application.resumeVariantId) || 'not selected'}`,
    `- Cover letter asset: ${stringValue(application.coverLetterAssetId) || 'not selected'}`,
    `- Packet asset: ${stringValue(application.packetAssetId) || 'assigned after save'}`,
    '',
    '## Inferred recommendations',
    '',
    '### Fit rationale and suggested positioning',
    '',
    ...fitRationale,
    '',
    '### Concerns / red flags',
    '',
    ...(concerns.length
      ? concerns.map((concern) => `- ${concern}`)
      : ['- No explicit concerns are recorded yet.']),
    '',
    '## Questions for the user',
    '',
    ...openQuestions.map((question) => `- ${question}`),
    '',
    '### ATS application questions',
    '',
    ...atsQuestionLines,
    '',
    '## Draft answers',
    '',
    ...draftAnswers.map((answer) => `- ${answer}`),
    '',
    '## Sources',
    '',
    ...(sourceUrls.length
      ? sourceUrls.map((url) => `- ${url}`)
      : ['- No source URLs are linked yet.']),
    '',
    '## Metadata',
    '',
    JSON.stringify(
      {
        applicationId,
        companyResearchIds: companyResearch
          .map((research) => stringValue(research.id))
          .filter(Boolean),
        factIds: verifiedCandidateFacts
          .map(({ fact }) => stringValue(fact.id))
          .filter(Boolean),
        linkedFactIds: factEntries
          .map(({ fact }) => stringValue(fact.id))
          .filter(Boolean),
        generatedAt: generatedAt.toISOString(),
        opportunityId,
        source: 'application_packet_generator',
      },
      null,
      2,
    ),
  ].join('\n');
}

async function generateApplicationPacketAsset(
  application: MutableRecord,
  opportunity: MutableRecord,
  assertWriteAllowed: () => void,
) {
  const generatedAt = new Date();
  const applicationId = stringValue(application.id);
  const opportunityId = stringValue(opportunity.id);
  const title = `Application packet - ${stringValue(opportunity.title) || opportunityId}`;
  const companyResearch = await companyResearchForOpportunity(opportunity);
  const factEntries = await factsForApplication(opportunity);
  const verifiedCandidateFacts = verifiedCandidateFactEntries(factEntries);
  const sourceUrls = packetSourceUrls({
    application,
    companyResearch,
    factEntries,
    opportunity,
  });
  const basePath = materialArtifactBasePath(
    applicationId,
    opportunityId,
    'packet',
    generatedAt,
  );
  const markdown = buildApplicationPacketMarkdown({
    application,
    companyResearch,
    factEntries,
    generatedAt,
    opportunity,
    sourceUrls,
  });
  const artifacts = await writeMaterialArtifacts({
    basePath,
    markdown,
    pdfBasename: materialPdfBasename(
      'application-packet',
      stringValue(opportunity.title),
      applicationId || opportunityId || 'packet',
    ),
    title,
  });

  // Filesystem work can outlive a lost session lock. Do not create the
  // database-visible asset unless the lifecycle gate is still held once that
  // external work returns.
  await assertMaterialArtifactWriteAllowed(artifacts, assertWriteAllowed);
  const assetCollection = await getCollection('ResumeAsset');
  const packetAsset = (await assetCollection.create(
    {},
  )) as unknown as MutableRecord;

  Object.assign(packetAsset, {
    applicationId,
    assetType: 'application_packet',
    generatedAt,
    generatedPath: basePath,
    htmlPath: artifacts.htmlPath,
    markdownPath: artifacts.markdownPath,
    notes: JSON.stringify(
      {
        applicationId,
        companyResearchIds: companyResearch
          .map((research) => stringValue(research.id))
          .filter(Boolean),
        factIds: verifiedCandidateFacts
          .map(({ fact }) => stringValue(fact.id))
          .filter(Boolean),
        linkedFactIds: factEntries
          .map(({ fact }) => stringValue(fact.id))
          .filter(Boolean),
        source: 'application_packet_generator',
        sourceUrls,
      },
      null,
      2,
    ),
    sourcePath: 'admin',
    status: 'generated',
    targetOpportunityId: opportunityId,
    pdfBasename: artifacts.pdfBasename,
    pdfPath: artifacts.pdfPath,
    textPath: artifacts.textPath,
    title,
  });
  assertWriteAllowed();
  await packetAsset.save();
  await assertPersistedMaterialAssetWriteAllowed({
    artifactPaths: artifacts,
    asset: packetAsset,
    assertWriteAllowed,
  });
  return packetAsset;
}

// Generates real cover-letter prose with the writing ("good") AI profile, which
// resolves to the snail Bifrost model. A requested cover letter must be a real,
// evidence-backed review artifact; callers surface a useful error instead of
// quietly binding boilerplate when generation cannot produce one.
async function generateCoverLetterProse(
  opportunity: MutableRecord,
  factEntries: Awaited<ReturnType<typeof factsForApplication>>,
  signal?: AbortSignal,
): Promise<{ body: string; model: string } | null> {
  let client: Awaited<ReturnType<typeof resolveWritingAiProfileClient>> = null;
  try {
    client = await resolveWritingAiProfileClient({
      usageTags: { feature: 'application-cover-letter' },
    });
  } catch {
    return null;
  }
  if (!client) return null;

  const facts = verifiedCandidateFactEntries(factEntries)
    .map(({ fact }) => stringValue(fact.textRefined))
    .filter(Boolean)
    .map((text, index) => `${index + 1}. ${text}`)
    .join('\n');
  if (!facts) return null;

  const messages: AIMessage[] = [
    {
      content:
        'You write concise, specific cover letters. Use ONLY the supplied verified candidate evidence — never invent employers, titles, dates, or metrics. Write three short paragraphs of plain prose: no salutation, no signature, no markdown headings, and no bracketed placeholders. Tie the candidate evidence directly to the role.',
      role: 'system',
    },
    {
      content: [
        `Role title: ${stringValue(opportunity.title) || 'the role'}`,
        stringValue(opportunity.descriptionSummary)
          ? `Role summary: ${stringValue(opportunity.descriptionSummary)}`
          : '',
        stringValue(opportunity.requiredSkills)
          ? `Required skills: ${stringValue(opportunity.requiredSkills)}`
          : '',
        stringValue(opportunity.preferredSkills)
          ? `Preferred skills: ${stringValue(opportunity.preferredSkills)}`
          : '',
        facts ? 'Candidate facts (verified evidence):' : '',
        facts,
        'Write the cover letter body now.',
      ]
        .filter((line) => line !== '')
        .join('\n\n'),
      role: 'user',
    },
  ];

  const chatOptions: ChatOptions = {
    maxTokens: 4_096,
    reasoning: { maxTokens: 1_024 },
    signal,
    temperature: 0.4,
    timeout: client.timeout,
  };
  if (client.model) chatOptions.model = client.model;

  try {
    const response = await client.aiClient.chat(messages, chatOptions);
    const body = stringValue(response.content);
    if (!body) return null;
    return { body, model: client.model };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

async function generateCoverLetterAsset(
  application: MutableRecord,
  opportunity: MutableRecord,
  signal?: AbortSignal,
  assertWriteAllowed?: () => void,
) {
  const now = new Date();
  const applicationId = stringValue(application.id);
  const opportunityId = stringValue(opportunity.id);
  const title = `Cover letter - ${stringValue(opportunity.title) || opportunityId}`;
  const factEntries = await factsForApplication(opportunity);
  const candidateFactEntries = verifiedCandidateFactEntries(factEntries);
  const prose = await generateCoverLetterProse(
    opportunity,
    candidateFactEntries,
    signal,
  );
  if (!prose) {
    error(
      422,
      'Could not generate a cover letter from verified candidate evidence. Add or verify the candidate facts and retry, or choose a different cover-letter mode.',
    );
  }
  const draftBody = prose.body;
  const factLines = candidateFactEntries.map(({ evidence, fact }, index) => {
    const evidenceIds = evidence
      .map((entry) => stringValue(entry.id))
      .filter(Boolean);
    return `${index + 1}. ${stringValue(fact.textRefined)} [fact:${stringValue(fact.id)}${
      evidenceIds.length ? ` evidence:${evidenceIds.join(',')}` : ''
    }]`;
  });
  const markdown = [
    `# ${title}`,
    '',
    `Opportunity: ${stringValue(opportunity.title)}`,
    stringValue(opportunity.postingUrl)
      ? `Posting: ${stringValue(opportunity.postingUrl)}`
      : '',
    '',
    '## Draft',
    '',
    draftBody,
    '',
    factLines.length
      ? 'The following internal facts should be used as supporting evidence while refining this letter:'
      : 'No reviewed supporting facts are linked to this opportunity yet.',
    '',
    ...factLines,
    '',
    '## Generation metadata',
    '',
    JSON.stringify(
      {
        applicationId,
        aiGenerated: true,
        factIds: candidateFactEntries
          .map(({ fact }) => stringValue(fact.id))
          .filter(Boolean),
        generatedAt: now.toISOString(),
        model: prose.model,
        opportunityId,
      },
      null,
      2,
    ),
  ]
    .filter((line) => line !== '')
    .join('\n');

  const basePath = materialArtifactBasePath(
    applicationId,
    opportunityId,
    'cover-letter',
    now,
  );
  const artifacts = await writeMaterialArtifacts({
    basePath,
    markdown,
    pdfBasename: materialPdfBasename(
      'cover-letter',
      stringValue(opportunity.title),
      applicationId || opportunityId || 'cover-letter',
    ),
    title,
  });

  if (assertWriteAllowed) {
    await assertMaterialArtifactWriteAllowed(artifacts, assertWriteAllowed);
  }
  const assetCollection = await getCollection('ResumeAsset');
  const asset = (await assetCollection.create({
    applicationId,
    assetType: 'cover_letter',
    generatedAt: now,
    generatedPath: basePath,
    htmlPath: artifacts.htmlPath,
    markdownPath: artifacts.markdownPath,
    notes: JSON.stringify({
      aiGenerated: true,
      factIds: candidateFactEntries
        .map(({ fact }) => stringValue(fact.id))
        .filter(Boolean),
      model: prose.model,
      source: 'application_package_generator',
    }),
    sourcePath: 'admin',
    status: 'generated',
    targetOpportunityId: opportunityId,
    pdfBasename: artifacts.pdfBasename,
    pdfPath: artifacts.pdfPath,
    textPath: artifacts.textPath,
    title,
  })) as unknown as MutableRecord;
  assertWriteAllowed?.();
  await asset.save();
  if (assertWriteAllowed) {
    await assertPersistedMaterialAssetWriteAllowed({
      artifactPaths: artifacts,
      asset,
      assertWriteAllowed,
    });
  }
  return asset;
}

export async function generateApplicationPackage(
  applicationId: string,
  options: {
    preflightOverrideReason?: string;
    signal?: AbortSignal;
    user?: Pick<User, 'id'> | null;
  } = {},
) {
  const applicationCollection = await getCollection('Application');
  const opportunityCollection = await getCollection('Opportunity');
  const application = (await applicationCollection.get(
    applicationId,
  )) as unknown as MutableRecord | null;
  if (!application) {
    error(404, 'Application not found.');
  }

  const opportunityId = stringValue(application.opportunityId);
  const opportunity = (await opportunityCollection.get(
    opportunityId,
  )) as unknown as MutableRecord | null;
  if (!opportunity) {
    error(404, 'Application opportunity not found.');
  }
  return await runWithFreshPostingPreflight({
    action: 'generate_packet',
    onClosed: async () => {
      await archiveApplicationsForClosedPosting(opportunityId);
    },
    opportunity,
    overrideReason: options.preflightOverrideReason,
    run: async (currentOpportunity) =>
      generateApplicationPackageAfterPreflight({
        applicationId,
        currentOpportunity,
        request: options,
      }),
    user: options.user,
  });
}

/**
 * Runs only while the opportunity lifecycle lock held by the posting
 * preflight gate is active. Keeping planning and material writes in this
 * callback prevents a concurrent closed-posting transition from archiving the
 * application between a successful check and its generated artifacts.
 */
async function generateApplicationPackageAfterPreflight(options: {
  applicationId: string;
  currentOpportunity: MutableRecord;
  request: {
    preflightOverrideReason?: string;
    signal?: AbortSignal;
    user?: Pick<User, 'id'> | null;
  };
}) {
  assertOpportunityLifecycleLockIsActive();
  const applicationCollection = await getCollection('Application');
  const application = (await applicationCollection.get(
    options.applicationId,
  )) as unknown as MutableRecord | null;
  if (!application) {
    error(404, 'Application not found.');
  }

  const opportunity = options.currentOpportunity;
  const opportunityId = stringValue(opportunity.id);
  if (stringValue(application.opportunityId) !== opportunityId) {
    error(
      409,
      'Application changed while its posting was being verified. Reload and review the current application.',
    );
  }
  assertMaterialGenerationIsAllowed(application);

  const existingMaterialAssetIds = materialAssetIdsFrom(application);

  assertOpportunityLifecycleLockIsActive();
  try {
    const { processOpportunityIntelligence } = await import(
      './opportunity-intelligence.js'
    );
    await processOpportunityIntelligence({
      applicationId: stringValue(application.id),
      assertWriteAllowed: assertOpportunityLifecycleLockIsActive,
      modes: ['plan'],
      opportunityId,
      runLifecycleMutation: runOpportunityLifecycleTransaction,
      signal: options.request.signal,
    });
    const plannedApplication = (await applicationCollection.get(
      stringValue(application.id),
    )) as unknown as MutableRecord | null;
    if (plannedApplication) {
      Object.assign(application, plannedApplication);
      restoreMaterialAssetIds(application, existingMaterialAssetIds);
    }
  } catch (error) {
    if (options.request.signal?.aborted) throw error;
    // Packet generation can proceed with the existing user-visible plan.
  }
  assertOpportunityLifecycleLockIsActive();

  // The planning pass can race a final approval. Re-check immediately before
  // any artifact work so an approved or submitting application is immutable.
  assertOpportunityLifecycleLockIsActive();
  assertMaterialGenerationIsAllowed(application);
  const applicationBeforeGeneration = { ...application };
  // SmrtObject exposes its public id through an accessor, so object spread
  // intentionally retains its persisted fields but not that id. Keep a
  // dedicated concurrency snapshot rather than adding id to the restoration
  // snapshot below.
  const applicationBeforeGenerationFence = {
    ...applicationBeforeGeneration,
    id: stringValue(application.id),
  };
  const cleanupLedger = createMaterialGenerationCleanupLedger();
  let existingResumeVariant: {
    persistedState: Record<string, unknown>;
    variant: MutableRecord;
  } | null = null;

  try {
    if (
      stringValue(application.resumeMode) === 'default' &&
      !stringValue(application.resumeAssetId)
    ) {
      const published =
        (await getPublishedResumeAsset()) as ResumeRecord | null;
      assertOpportunityLifecycleLockIsActive();
      application.resumeAssetId = published?.id ?? '';
    } else if (stringValue(application.resumeMode) === 'generate_tailored') {
      const { generateResumeAsset } = await import('./resume-admin.js');
      const resumeVariant = await getOrCreateResumeVariantForApplication(
        application,
        opportunity,
      );
      const { persistedState, variant } = resumeVariant;
      if (persistedState) {
        existingResumeVariant = { persistedState, variant };
      } else {
        trackNewResumeVariant(cleanupLedger, variant);
      }
      const tailoringOptions = await tailoringOptionsForResumeVariant(variant);
      const asset = await generateResumeAsset({
        applicationId: stringValue(application.id),
        assertWriteAllowed: assertOpportunityLifecycleLockIsActive,
        tailoring: tailoringOptions.tailoring,
        tailoringId: tailoringOptions.tailoringId,
        tailoringName: tailoringOptions.tailoringName,
        tailoringSlug: tailoringOptions.tailoringSlug,
        targetOpportunityId: opportunityId,
      });
      trackGeneratedMaterialAsset(
        cleanupLedger,
        asset as unknown as MutableRecord,
      );
      assertOpportunityLifecycleLockIsActive();
      application.resumeAssetId = stringValue(asset.id);
      syncResumeVariantArtifact({
        application,
        asset,
        opportunity,
        tailoringConfigPath: tailoringOptions.tailoringConfigPath,
        variant,
      });
      assertOpportunityLifecycleLockIsActive();
      if (!persistedState) {
        await variant.save();
        assertOpportunityLifecycleLockIsActive();
      }
    }

    if (stringValue(application.coverLetterMode) === 'generate') {
      const asset = await generateCoverLetterAsset(
        application,
        opportunity,
        options.request.signal,
        assertOpportunityLifecycleLockIsActive,
      );
      trackGeneratedMaterialAsset(cleanupLedger, asset);
      assertOpportunityLifecycleLockIsActive();
      application.coverLetterAssetId = stringValue(asset.id);
    }

    // Fetch the schema before rendering the packet so review can show the
    // actual ATS questions and clearly flag any user-required answers. A
    // schema-fetch failure remains non-fatal, but any prior schema must not
    // masquerade as current: it is cleared and rendered as unavailable.
    assertOpportunityLifecycleLockIsActive();
    try {
      const { persistApplicationFormSchema } = await import(
        './ats-form-schema.js'
      );
      const result = await persistApplicationFormSchema(application);
      if (!result.persisted) application.requiredQuestionsJson = '';
      if (result.persisted) {
        // Seed verified candidate profile facts and explicitly reusable
        // answers into the freshly fetched schema so review starts from known
        // values. Fills gaps only — existing application answers always win,
        // and unknown questions stay unanswered. Best-effort: a seeding
        // failure must not block packet generation.
        assertOpportunityLifecycleLockIsActive();
        try {
          const { seedApplicationAnswersFromCandidateProfile } = await import(
            './candidate-answers.js'
          );
          await seedApplicationAnswersFromCandidateProfile(application);
        } catch {
          // Leave answers untouched when profile/library facts can't be read.
        }
        assertOpportunityLifecycleLockIsActive();
      }
    } catch {
      application.requiredQuestionsJson = '';
    }
    assertOpportunityLifecycleLockIsActive();

    const packetAsset = await generateApplicationPacketAsset(
      application,
      opportunity,
      assertOpportunityLifecycleLockIsActive,
    );
    trackGeneratedMaterialAsset(cleanupLedger, packetAsset);
    assertOpportunityLifecycleLockIsActive();
    application.packetAssetId = stringValue(packetAsset.id);

    const currentStatus = normalizeApplicationStatus(application.status);
    if (currentStatus === 'draft' || currentStatus === 'application_drafting') {
      application.status = 'awaiting_user';
    } else if (applicationApprovalShouldInvalidate(currentStatus)) {
      application.status = 'awaiting_user';
      clearApplicationApprovalFields(application);
    }

    const updates = Object.fromEntries(
      [...applicationApprovalScopeKeys, 'status'].flatMap((field) =>
        application[field] === applicationBeforeGeneration[field]
          ? []
          : [[field, application[field]]],
      ),
    );
    await runOpportunityLifecycleTransaction(async (database) => {
      if (
        existingResumeVariant &&
        !(await commitResumeVariantIfCurrent(
          existingResumeVariant.persistedState,
          existingResumeVariant.variant,
          database,
        ))
      ) {
        restoreMutableRecord(
          existingResumeVariant.variant,
          existingResumeVariant.persistedState,
        );
        error(
          409,
          'Resume variant changed while materials were generated. Reload and review the current application.',
        );
      }
      if (
        Object.keys(updates).length > 0 &&
        !(await commitApplicationIfCurrent(
          applicationBeforeGenerationFence,
          updates,
          database,
        ))
      ) {
        restoreMutableRecord(application, applicationBeforeGeneration);
        error(
          409,
          'Application changed while materials were generated. Reload and review the current application.',
        );
      }
      await recordAgentAudit({
        application,
        database,
        output: {
          coverLetterAssetId: stringValue(application.coverLetterAssetId),
          packetAssetId: stringValue(packetAsset.id),
          resumeAssetId: stringValue(application.resumeAssetId),
          resumeVariantId: stringValue(application.resumeVariantId),
        },
        runType: 'application_packet',
        status: 'succeeded',
      });
      await syncApplicationWorkflowTasks(application);
    });
    return jsonRecord(application);
  } catch (cause) {
    await cleanupMaterialGenerationAttempt(cleanupLedger);
    throw cause;
  }
}
