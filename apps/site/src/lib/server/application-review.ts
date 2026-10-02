import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import {
  applicationHasMaterialWriteLock,
  applicationMaterialsAreLockedOrLeased,
  clearApplicationApprovalFields,
  finalApprovalMaterialSnapshotMatches,
  finalSubmissionApprovalKind,
  hasFinalApplicationApproval,
  recordFinalApplicationApproval,
} from '$lib/objects/application-approval-scope';
import { validateApplicationStatusTransition } from '$lib/objects/lifecycle';
import {
  isActiveTaskStatus,
  submissionMethodDefinitions,
  submittedByRoleDefinitions,
} from '$lib/objects/workflow';
import { commitApplicationIfCurrent } from './application-concurrency.js';
import { applicationResumePdfFile } from './application-resume-file.js';
import {
  recordAgentAudit,
  recordApplicationSubmission,
  recordApplicationSubmissionBlocker,
  syncApplicationWorkflowTasks,
} from './application-workflow.js';
import { summarizeApplicationFormAnswers } from './auto-submit-eligibility.js';
import {
  describeApplicationAnswersBody,
  loadApplicationAnswersEditorState,
} from './candidate-answers.js';
import { latestPostingPreflightStatus } from './posting-preflight-status.js';
import {
  createPrivateRecord,
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getResumeFilesystem } from './resume-files.js';
import { getCollection } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};
type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  get: (id: string) => Promise<MutableRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};
type ReviewActor = { id: string };

export type ApplicationReviewMaterial = {
  availability: 'ready' | 'not_required' | 'needs_attention';
  body: string;
  href: string;
  label: string;
  materialRecordId: string;
  materialRecordType: string;
  materialType: string;
  materialVersion: string;
  notice: string;
  pdfDigest: string;
  pdfFilename: string;
  path: string;
  pdfHref: string;
  pdfPath: string;
  reviewStatus: 'not_reviewed' | 'reviewed';
  title: string;
};

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return '';
}

async function collection(className: string): Promise<Collection> {
  return (await getCollection(className)) as unknown as Collection;
}

async function findRecord(
  className: string,
  id: string,
): Promise<MutableRecord | null> {
  if (!id) return null;
  const records = await collection(className);
  const direct = await records.get(id);
  if (direct) return direct;

  const listed = await records.list({
    limit: 1000,
    orderBy: 'updated_at DESC',
  });
  return listed.find((record) => stringValue(record.id) === id) ?? null;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function materialVersion(
  materialType: string,
  materialRecordId: string,
  preview: {
    body: string;
    path: string;
    pdfDigest: string;
    pdfFilename: string;
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        body: preview.body,
        id: materialRecordId,
        materialType,
        path: preview.path,
        pdfDigest: preview.pdfDigest,
        pdfFilename: preview.pdfFilename,
      }),
    )
    .digest('hex');
}

async function requirePrivateApplication(
  applicationId: string,
  subject: WorkspaceSubject,
): Promise<MutableRecord> {
  const application = (await getPrivateRecord(
    'Application',
    applicationId,
    requireWorkspaceSubject(subject),
  )) as MutableRecord | null;
  if (!application) error(404, 'Application not found.');
  return application;
}

async function copyAssetTextFile(
  sourcePath: string,
  targetPath: string,
): Promise<string> {
  if (!sourcePath) return '';
  const filesystem = await getResumeFilesystem();
  if (!(await filesystem.exists(sourcePath))) return '';
  const content = await filesystem.read(sourcePath);
  await filesystem.write(targetPath, content, { createParents: true });
  return targetPath;
}

async function copyAssetBinaryFile(
  sourcePath: string,
  targetPath: string,
): Promise<string> {
  if (!sourcePath) return '';
  const filesystem = await getResumeFilesystem();
  if (!(await filesystem.exists(sourcePath))) return '';
  const content = await filesystem.read(sourcePath, { raw: true });
  await filesystem.write(targetPath, content, { createParents: true });
  return targetPath;
}

async function cloneAssetForApplication(options: {
  application: MutableRecord;
  materialType: string;
  source: MutableRecord;
  subject: WorkspaceSubject;
}): Promise<MutableRecord> {
  const { application, materialType, source, subject } = options;
  const applicationId = stringValue(application.id);
  const sourceId = stringValue(source.id);
  const clone = (await createPrivateRecord('ResumeAsset', subject, {
    applicationId,
    assetType: stringValue(source.assetType) || materialType,
    candidateProfileId: stringValue(source.candidateProfileId),
    generatedAt: new Date(),
    isPublished: false,
    notes: stringValue(source.notes),
    sourceAssetId: sourceId,
    sourcePath: stringValue(source.sourcePath),
    status: 'generated',
    tailoringId: stringValue(source.tailoringId),
    targetOpportunityId: stringValue(source.targetOpportunityId),
    title: stringValue(source.title) || `Application ${materialType}`,
  })) as MutableRecord;
  await clone.save();

  const cloneId = stringValue(clone.id);
  const basePath = `application-packages/${applicationId}/${materialType}-${cloneId}`;
  const markdownPath = await copyAssetTextFile(
    stringValue(source.markdownPath),
    `${basePath}.md`,
  );
  const textPath = await copyAssetTextFile(
    stringValue(source.textPath),
    `${basePath}.txt`,
  );
  const htmlPath = await copyAssetTextFile(
    stringValue(source.htmlPath),
    `${basePath}.html`,
  );
  const pdfPath = await copyAssetBinaryFile(
    stringValue(source.pdfPath),
    `${basePath}.pdf`,
  );

  Object.assign(clone, {
    generatedPath: basePath,
    htmlPath,
    markdownPath,
    outputSlug: stringValue(source.outputSlug),
    pdfBasename: stringValue(source.pdfBasename),
    pdfPath,
    textPath,
  });
  await clone.save();
  return clone;
}

function assetHasAnyArtifact(asset: MutableRecord | null): boolean {
  return Boolean(
    asset &&
      (stringValue(asset.markdownPath) ||
        stringValue(asset.textPath) ||
        stringValue(asset.htmlPath) ||
        stringValue(asset.pdfPath)),
  );
}

function normalizedMaterialType(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, '_');
}

function assetMatchesMaterialType(
  asset: MutableRecord,
  materialType: string,
): boolean {
  const assetType = normalizedMaterialType(stringValue(asset.assetType));
  const targetType = normalizedMaterialType(materialType);
  if (targetType === 'packet') {
    return assetType === 'packet' || assetType === 'application_packet';
  }
  return assetType === targetType;
}

async function findApplicationOwnedAsset(options: {
  application: MutableRecord;
  materialType: string;
  sourceAssetId?: string;
  subject: WorkspaceSubject;
}): Promise<MutableRecord | null> {
  const applicationId = stringValue(options.application.id);
  if (!applicationId) return null;
  const candidates = (await listPrivateRecords('ResumeAsset', options.subject, {
    limit: 1000,
    orderBy: 'updated_at DESC',
    where: { applicationId },
  })) as MutableRecord[];
  const materialCandidates = candidates.filter((candidate) =>
    assetMatchesMaterialType(candidate, options.materialType),
  );
  const sourceAssetId = stringValue(options.sourceAssetId);
  if (sourceAssetId) {
    const sourceMatch = materialCandidates.find(
      (candidate) => stringValue(candidate.sourceAssetId) === sourceAssetId,
    );
    if (sourceMatch) return sourceMatch;
  }
  return materialCandidates[0] ?? null;
}

function normalizedAssetText(value: unknown): string {
  return stringValue(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

function assetLooksCanonical(asset: MutableRecord): boolean {
  return (
    normalizedAssetText(asset.outputSlug) === 'canonical' ||
    normalizedAssetText(asset.title).includes('canonical') ||
    stringValue(asset.generatedPath) === 'generated-resumes/legacy-current'
  );
}

function assetMatchesArtifactSource(
  asset: MutableRecord,
  candidate: MutableRecord,
): boolean {
  if (stringValue(candidate.id) === stringValue(asset.id)) return false;
  if (stringValue(candidate.applicationId)) return false;

  const assetOutputSlug = normalizedAssetText(asset.outputSlug);
  if (
    assetOutputSlug &&
    assetOutputSlug === normalizedAssetText(candidate.outputSlug)
  ) {
    return true;
  }

  if (assetLooksCanonical(asset) && assetLooksCanonical(candidate)) {
    return true;
  }

  const assetTailoringId = stringValue(asset.tailoringId);
  return Boolean(
    assetTailoringId && assetTailoringId === stringValue(candidate.tailoringId),
  );
}

async function findFallbackArtifactSource(
  asset: MutableRecord,
  subject: WorkspaceSubject,
): Promise<MutableRecord | null> {
  const candidates = (await listPrivateRecords('ResumeAsset', subject, {
    limit: 1000,
    orderBy: 'updated_at DESC',
  })) as MutableRecord[];
  return (
    candidates.find(
      (candidate) =>
        assetMatchesArtifactSource(asset, candidate) &&
        assetHasAnyArtifact(candidate),
    ) ?? null
  );
}

async function backfillApplicationAssetArtifacts(options: {
  application: MutableRecord;
  asset: MutableRecord;
  materialType: string;
  subject: WorkspaceSubject;
}): Promise<void> {
  const { application, asset, materialType, subject } = options;
  const sourceAssetId = stringValue(asset.sourceAssetId);
  const source =
    (sourceAssetId
      ? ((await getPrivateRecord(
          'ResumeAsset',
          sourceAssetId,
          subject,
        )) as MutableRecord | null)
      : null) ?? (await findFallbackArtifactSource(asset, subject));
  if (!source) return;

  const applicationId = stringValue(application.id);
  const assetId = stringValue(asset.id);
  const basePath =
    stringValue(asset.generatedPath) ||
    `application-packages/${applicationId}/${materialType}-${assetId}`;
  let changed = false;

  if (!stringValue(asset.generatedPath)) {
    asset.generatedPath = basePath;
    changed = true;
  }

  if (!stringValue(asset.markdownPath)) {
    const markdownPath = await copyAssetTextFile(
      stringValue(source.markdownPath),
      `${basePath}.md`,
    );
    if (markdownPath) {
      asset.markdownPath = markdownPath;
      changed = true;
    }
  }

  if (!stringValue(asset.textPath)) {
    const textPath = await copyAssetTextFile(
      stringValue(source.textPath),
      `${basePath}.txt`,
    );
    if (textPath) {
      asset.textPath = textPath;
      changed = true;
    }
  }

  if (!stringValue(asset.htmlPath)) {
    const htmlPath = await copyAssetTextFile(
      stringValue(source.htmlPath),
      `${basePath}.html`,
    );
    if (htmlPath) {
      asset.htmlPath = htmlPath;
      changed = true;
    }
  }

  if (!stringValue(asset.pdfPath)) {
    const pdfPath = await copyAssetBinaryFile(
      stringValue(source.pdfPath),
      `${basePath}.pdf`,
    );
    if (pdfPath) {
      asset.pdfPath = pdfPath;
      changed = true;
    }
  }

  if (!stringValue(asset.pdfBasename) && stringValue(source.pdfBasename)) {
    asset.pdfBasename = stringValue(source.pdfBasename);
    changed = true;
  }

  if (!stringValue(asset.outputSlug) && stringValue(source.outputSlug)) {
    asset.outputSlug = stringValue(source.outputSlug);
    changed = true;
  }

  if (changed) await asset.save();
}

async function ensureApplicationAsset(
  application: MutableRecord,
  fieldKey: 'coverLetterAssetId' | 'packetAssetId' | 'resumeAssetId',
  materialType: string,
  subject: WorkspaceSubject,
): Promise<MutableRecord | null> {
  const assetId = stringValue(application[fieldKey]);
  if (!assetId) return null;
  const source = (await getPrivateRecord(
    'ResumeAsset',
    assetId,
    subject,
  )) as MutableRecord | null;
  if (!source) {
    const recovered = await findApplicationOwnedAsset({
      application,
      materialType,
      sourceAssetId: assetId,
      subject,
    });
    if (!recovered) return null;
    application[fieldKey] = stringValue(recovered.id);
    await backfillApplicationAssetArtifacts({
      application,
      asset: recovered,
      materialType,
      subject,
    });
    return recovered;
  }
  if (stringValue(source.applicationId) === stringValue(application.id)) {
    await backfillApplicationAssetArtifacts({
      application,
      asset: source,
      materialType,
      subject,
    });
    return source;
  }
  const existingClone = await findApplicationOwnedAsset({
    application,
    materialType,
    sourceAssetId: stringValue(source.id),
    subject,
  });
  if (existingClone) {
    application[fieldKey] = stringValue(existingClone.id);
    await backfillApplicationAssetArtifacts({
      application,
      asset: existingClone,
      materialType,
      subject,
    });
    return existingClone;
  }
  const clone = await cloneAssetForApplication({
    application,
    materialType,
    source,
    subject,
  });
  application[fieldKey] = stringValue(clone.id);
  return clone;
}

async function cloneVariantForApplication(
  application: MutableRecord,
  source: MutableRecord,
  subject: WorkspaceSubject,
): Promise<MutableRecord> {
  const clone = (await createPrivateRecord('ResumeVariant', subject, {
    applicationId: stringValue(application.id),
    candidateProfileId: stringValue(source.candidateProfileId),
    companyId: stringValue(source.companyId),
    emphasizeTags: stringValue(source.emphasizeTags),
    excludePositionIds: stringValue(source.excludePositionIds),
    excludeTags: stringValue(source.excludeTags),
    generatedAt: source.generatedAt ?? null,
    generatedPath: stringValue(source.generatedPath),
    htmlPath: stringValue(source.htmlPath),
    includePositionIds: stringValue(source.includePositionIds),
    markdownPath: stringValue(source.markdownPath),
    name: stringValue(source.name) || 'Application resume variant',
    opportunityId: stringValue(source.opportunityId),
    outputSlug: stringValue(source.outputSlug),
    pdfPath: stringValue(source.pdfPath),
    resumeAssetId: stringValue(application.resumeAssetId),
    sourceVariantId: stringValue(source.id),
    status: 'draft',
    summaryOverride: stringValue(source.summaryOverride),
    tailoringConfigId: stringValue(source.tailoringConfigId),
    tailoringConfigPath: stringValue(source.tailoringConfigPath),
    textPath: stringValue(source.textPath),
    titleOverride: stringValue(source.titleOverride),
  })) as MutableRecord;
  await clone.save();
  application.resumeVariantId = stringValue(clone.id);
  return clone;
}

async function ensureApplicationVariant(
  application: MutableRecord,
  subject: WorkspaceSubject,
): Promise<MutableRecord | null> {
  const variantId = stringValue(application.resumeVariantId);
  if (!variantId) return null;
  const source = (await getPrivateRecord(
    'ResumeVariant',
    variantId,
    subject,
  )) as MutableRecord | null;
  if (!source) return null;
  if (stringValue(source.applicationId) === stringValue(application.id)) {
    return source;
  }
  return await cloneVariantForApplication(application, source, subject);
}

async function readMaterialBody(record: MutableRecord | null): Promise<{
  body: string;
  path: string;
  pdfDigest: string;
  pdfFilename: string;
}> {
  if (!record) {
    return { body: '', path: '', pdfDigest: '', pdfFilename: '' };
  }
  const filesystem = await getResumeFilesystem();
  let body = '';
  let path = '';
  for (const candidatePath of [
    stringValue(record.markdownPath),
    stringValue(record.textPath),
    stringValue(record.htmlPath),
  ]) {
    if (!candidatePath || !(await filesystem.exists(candidatePath))) continue;
    const content = await filesystem.read(candidatePath);
    body = typeof content === 'string' ? content : content.toString();
    path = candidatePath;
    break;
  }
  const pdfPath = stringValue(record.pdfPath);
  let pdfDigest = '';
  if (pdfPath && (await filesystem.exists(pdfPath))) {
    const bytes = await filesystem.read(pdfPath, { raw: true });
    pdfDigest = createHash('sha256')
      .update(bytes as Uint8Array)
      .digest('hex');
  }
  return {
    body,
    path,
    pdfDigest,
    pdfFilename: stringValue(record.pdfBasename),
  };
}

async function reviewMaterialsForApplication(
  application: MutableRecord,
  assets: {
    coverLetter: MutableRecord | null;
    packet: MutableRecord | null;
    resume: MutableRecord | null;
  },
  subject: WorkspaceSubject,
): Promise<ApplicationReviewMaterial[]> {
  const materialInputs = [
    {
      href: assets.packet?.id
        ? `/admin/resume-assets/${assets.packet.id}`
        : `/admin/applications/${application.id}`,
      label: 'Packet',
      record: assets.packet,
      recordType: assets.packet ? 'ResumeAsset' : 'Application',
      type: 'packet',
    },
    {
      href: assets.resume?.id
        ? `/admin/resume-assets/${assets.resume.id}`
        : `/admin/applications/${application.id}`,
      label: 'Resume',
      record: assets.resume,
      recordType: assets.resume ? 'ResumeAsset' : 'Application',
      type: 'resume',
    },
    {
      href: assets.coverLetter?.id
        ? `/admin/resume-assets/${assets.coverLetter.id}`
        : `/admin/applications/${application.id}`,
      label: 'Cover letter',
      record: assets.coverLetter,
      recordType: assets.coverLetter ? 'ResumeAsset' : 'Application',
      type: 'cover_letter',
    },
  ];

  const materials = await Promise.all(
    materialInputs.map(async (material) => {
      const rawPreview = await readMaterialBody(material.record);
      const selectedResume =
        material.type === 'resume'
          ? await applicationResumePdfFile(application, subject)
          : null;
      const preview = {
        ...rawPreview,
        pdfFilename:
          material.type === 'resume'
            ? (selectedResume?.filename ?? rawPreview.pdfFilename)
            : rawPreview.pdfFilename,
      };
      const coverLetterMode = stringValue(application.coverLetterMode);
      const availability: ApplicationReviewMaterial['availability'] =
        material.type === 'cover_letter' && coverLetterMode === 'none'
          ? 'not_required'
          : material.type === 'cover_letter' && !preview.body
            ? 'needs_attention'
            : material.record
              ? 'ready'
              : 'needs_attention';
      const notice =
        availability === 'not_required'
          ? 'No cover letter is required for this application.'
          : availability === 'needs_attention' &&
              material.type === 'cover_letter'
            ? 'This application requests a cover letter, but no reviewable artifact is selected. Regenerate it or choose a different cover-letter mode before final approval.'
            : availability === 'needs_attention'
              ? `No reviewable ${material.label.toLowerCase()} artifact is selected yet.`
              : '';
      const body = preview.body || notice;
      const recordId = stringValue(material.record?.id);
      const materialRecordId = stringValue(
        material.record?.id ?? application.id,
      );
      const pdfPath = stringValue(material.record?.pdfPath);
      return {
        availability,
        body,
        href: material.href,
        label: material.label,
        materialRecordId,
        materialRecordType: material.recordType,
        materialType: material.type,
        materialVersion: materialVersion(
          material.type,
          materialRecordId,
          preview,
        ),
        notice,
        pdfDigest: preview.pdfDigest,
        pdfFilename: preview.pdfFilename,
        path: preview.path,
        pdfHref:
          material.recordType === 'ResumeAsset' && recordId && pdfPath
            ? `/admin/resume-assets/${recordId}/pdf`
            : '',
        pdfPath,
        reviewStatus: 'not_reviewed' as const,
        title:
          stringValue(material.record?.title) ||
          stringValue(material.record?.name) ||
          material.label,
      };
    }),
  );

  // Readable per-question rendering derived only from application fields, so
  // the answers material fingerprint never depends on profile/library state.
  const answersBody = describeApplicationAnswersBody(application);
  const answersMaterialRecordId = stringValue(application.id);
  materials.push({
    availability: 'ready',
    body: answersBody,
    href: `/admin/applications/${application.id}`,
    label: 'Answers',
    materialRecordId: answersMaterialRecordId,
    materialRecordType: 'Application',
    materialType: 'answers',
    materialVersion: materialVersion('answers', answersMaterialRecordId, {
      body: answersBody,
      path: '',
      pdfDigest: '',
      pdfFilename: '',
    }),
    notice: '',
    pdfDigest: '',
    pdfFilename: '',
    path: '',
    pdfHref: '',
    pdfPath: '',
    reviewStatus: 'not_reviewed',
    title: 'Application answers',
  });

  return materials;
}

function finalApprovalMaterials(
  materials: readonly ApplicationReviewMaterial[],
) {
  return materials.map((material) => ({
    materialRecordId: material.materialRecordId,
    materialType: material.materialType,
    materialVersion: material.materialVersion,
    pdfDigest: material.pdfDigest,
    pdfFilename: material.pdfFilename,
  }));
}

function isoTime(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

async function applicationOwnedReviewAsset(
  application: MutableRecord,
  fieldKey: 'coverLetterAssetId' | 'packetAssetId' | 'resumeAssetId',
  subject: WorkspaceSubject,
): Promise<MutableRecord | null> {
  const applicationId = stringValue(application.id);
  const assetId = stringValue(application[fieldKey]);
  if (!applicationId || !assetId) return null;
  const asset = (await getPrivateRecord(
    'ResumeAsset',
    assetId,
    subject,
  )) as MutableRecord | null;
  return stringValue(asset?.applicationId) === applicationId ? asset : null;
}

async function reviewMaterialsForFinalApprovalVerification(
  application: MutableRecord,
  subject: WorkspaceSubject,
): Promise<ApplicationReviewMaterial[]> {
  const [coverLetter, packet, resume] = await Promise.all([
    applicationOwnedReviewAsset(application, 'coverLetterAssetId', subject),
    applicationOwnedReviewAsset(application, 'packetAssetId', subject),
    applicationOwnedReviewAsset(application, 'resumeAssetId', subject),
  ]);
  return await reviewMaterialsForApplication(
    application,
    {
      coverLetter,
      packet,
      resume,
    },
    subject,
  );
}

function finalApprovalAuditMatches(
  application: MutableRecord,
  audit: MutableRecord,
): boolean {
  try {
    const snapshot = JSON.parse(
      stringValue(audit.approvalSnapshotJson),
    ) as Record<string, unknown>;
    return (
      isoTime(snapshot.finalApprovalAt) ===
        isoTime(application.finalApprovalAt) &&
      stringValue(snapshot.finalApprovalKind) ===
        stringValue(application.finalApprovalKind) &&
      stringValue(snapshot.finalApprovedByUserId) ===
        stringValue(application.finalApprovedByUserId) &&
      stringValue(snapshot.finalApprovalMaterialsJson) ===
        stringValue(application.finalApprovalMaterialsJson)
    );
  } catch {
    return false;
  }
}

async function finalApprovalSuccessAuditExists(
  application: MutableRecord,
  subject: WorkspaceSubject,
): Promise<boolean> {
  const applicationId = stringValue(application.id);
  if (!applicationId) return false;
  const audits = await listPrivateRecords('AgentRun', subject, {
    limit: 25,
    orderBy: 'started_at DESC',
    where: {
      applicationId,
      runType: 'application_final_approval',
      status: 'succeeded',
    },
  });
  return audits.some((audit) => finalApprovalAuditMatches(application, audit));
}

/**
 * Verifies the material snapshot taken by the dedicated final-approval action
 * against the current application-owned artifacts. This runs immediately
 * before automatic submission; an edited file cannot inherit old approval.
 */
export async function finalApplicationApprovalMaterialsAreCurrent(
  applicationId: string,
  subject: WorkspaceSubject,
): Promise<boolean> {
  if (!applicationId) return false;
  const verifiedSubject = requireWorkspaceSubject(subject);
  const application = await requirePrivateApplication(
    applicationId,
    verifiedSubject,
  );
  const materials = await reviewMaterialsForFinalApprovalVerification(
    application,
    verifiedSubject,
  );
  const resume = materials.find(
    (material) => material.materialType === 'resume',
  );
  return (
    finalApprovalMaterialSnapshotMatches(
      application,
      finalApprovalMaterials(materials),
    ) &&
    Boolean(resume?.pdfDigest) &&
    (await finalApprovalSuccessAuditExists(application, verifiedSubject))
  );
}

export async function ensureApplicationReviewMaterials(
  applicationId: string,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  const application = await requirePrivateApplication(
    applicationId,
    verifiedSubject,
  );
  const opportunity = stringValue(application.opportunityId)
    ? await findRecord('Opportunity', stringValue(application.opportunityId))
    : null;

  if (applicationHasMaterialWriteLock(application)) {
    error(
      409,
      'Application materials are being updated. Reload after the update completes.',
    );
  }

  // A final-approved application is strictly read-only here. Repairing or
  // replacing a selected asset after its snapshot was approved would mutate
  // the very material that execution later verifies.
  if (hasFinalApplicationApproval(application)) {
    const [coverLetter, packet, resume] = await Promise.all([
      applicationOwnedReviewAsset(
        application,
        'coverLetterAssetId',
        verifiedSubject,
      ),
      applicationOwnedReviewAsset(
        application,
        'packetAssetId',
        verifiedSubject,
      ),
      applicationOwnedReviewAsset(
        application,
        'resumeAssetId',
        verifiedSubject,
      ),
    ]);
    return {
      application,
      assets: { coverLetter, packet, resume },
      opportunity,
    };
  }

  const beforePreparation = jsonRecord(application);

  const resume = await ensureApplicationAsset(
    application,
    'resumeAssetId',
    'resume',
    verifiedSubject,
  );
  const packet = await ensureApplicationAsset(
    application,
    'packetAssetId',
    'packet',
    verifiedSubject,
  );
  const coverLetter = await ensureApplicationAsset(
    application,
    'coverLetterAssetId',
    'cover-letter',
    verifiedSubject,
  );
  await ensureApplicationVariant(application, verifiedSubject);
  const materialBindingUpdates = Object.fromEntries(
    [
      'coverLetterAssetId',
      'packetAssetId',
      'resumeAssetId',
      'resumeVariantId',
    ].flatMap((key) =>
      stringValue(application[key]) === stringValue(beforePreparation[key])
        ? []
        : [[key, application[key]] as const],
    ),
  );
  if (Object.keys(materialBindingUpdates).length > 0) {
    if (
      !(await commitApplicationIfCurrent(
        beforePreparation,
        materialBindingUpdates,
      ))
    ) {
      error(
        409,
        'Application changed while review materials were being prepared. Reload and review the current materials.',
      );
    }
  }

  return {
    application,
    assets: { coverLetter, packet, resume },
    opportunity,
  };
}

async function findActiveSubmissionTaskId(
  applicationId: string,
  subject: WorkspaceSubject,
): Promise<string> {
  const tasks = await listPrivateRecords('Task', subject, {
    limit: 25,
    orderBy: 'updated_at DESC',
    where: { applicationId, taskType: 'submit_application' },
  });
  const active = tasks.find((task) => isActiveTaskStatus(task.status));
  return stringValue(active?.id);
}

export async function loadApplicationReviewPageData(
  applicationId: string,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const reviewState = await ensureApplicationReviewMaterials(
    applicationId,
    verifiedSubject,
  );
  const comments = await listPrivateRecords(
    'ApplicationMaterialComment',
    verifiedSubject,
    {
      orderBy: 'updated_at DESC',
      where: { applicationId },
    },
  );
  const company =
    reviewState.opportunity && stringValue(reviewState.opportunity.companyId)
      ? await findRecord(
          'Company',
          stringValue(reviewState.opportunity.companyId),
        )
      : null;

  const materials = await reviewMaterialsForApplication(
    reviewState.application,
    reviewState.assets,
    verifiedSubject,
  );
  const commentRecords = comments.map(jsonRecord);

  return {
    application: jsonRecord(reviewState.application),
    answersEditor: await loadApplicationAnswersEditorState(
      reviewState.application,
      verifiedSubject,
      verifiedSubject,
    ),
    autoSubmit: summarizeApplicationFormAnswers(reviewState.application),
    comments: commentRecords,
    company: company ? jsonRecord(company) : null,
    materials: materials.map((material) => ({
      ...material,
      reviewStatus: commentRecords.some(
        (comment) =>
          stringValue(comment.status) === 'reviewed' &&
          stringValue(comment.materialRecordId) === material.materialRecordId &&
          stringValue(comment.materialType) === material.materialType &&
          stringValue(comment.materialVersion) === material.materialVersion,
      )
        ? 'reviewed'
        : 'not_reviewed',
    })),
    // This indicator uses the same read-only execution gate as submission,
    // including the matching completed final-approval audit. Do not present a
    // pending approval audit as executable simply because its fingerprints
    // still match.
    finalApprovalMaterialsCurrent:
      await finalApplicationApprovalMaterialsAreCurrent(
        applicationId,
        verifiedSubject,
      ),
    opportunity: reviewState.opportunity
      ? jsonRecord(reviewState.opportunity)
      : null,
    // A fresh packet-generation preflight is authoritative, but a recorded
    // inconclusive result tells the owner why the next generation needs their
    // explicit confirmation. Keep the page contract intentionally narrow: the
    // detail UI only needs to know whether to present that human-only field.
    preflight: {
      requiresOverride:
        (
          await latestPostingPreflightStatus(
            stringValue(reviewState.application.opportunityId),
          )
        ).state === 'inconclusive',
    },
    submissionOptions: {
      methods: submissionMethodDefinitions.map((definition) => ({
        ...definition,
      })),
      roles: submittedByRoleDefinitions.map((definition) => ({
        ...definition,
      })),
    },
    submissionTaskId: await findActiveSubmissionTaskId(
      applicationId,
      verifiedSubject,
    ),
  };
}

export type ApplicationReviewSnapshot = {
  application: Record<string, unknown>;
  comments: Record<string, unknown>[];
  finalApprovalMaterialsCurrent: boolean;
  materials: ApplicationReviewMaterial[];
};

/**
 * Read-only review context for one application. Unlike
 * `loadApplicationReviewPageData()` this never prepares, clones, or re-binds
 * material assets: it fingerprints only the assets already selected on and
 * owned by the application, so an agent read cannot mutate review state.
 * Returns null when the application does not exist.
 */
export async function loadApplicationReviewSnapshot(
  applicationId: string,
  subject: WorkspaceSubject,
): Promise<ApplicationReviewSnapshot | null> {
  const verifiedSubject = requireWorkspaceSubject(subject);
  const id = stringValue(applicationId);
  if (!id) return null;
  const application = (await getPrivateRecord(
    'Application',
    id,
    verifiedSubject,
  )) as MutableRecord | null;
  if (!application) return null;

  const [materials, comments] = await Promise.all([
    reviewMaterialsForFinalApprovalVerification(application, verifiedSubject),
    listPrivateRecords('ApplicationMaterialComment', verifiedSubject, {
      limit: 500,
      orderBy: 'updated_at DESC',
      where: { applicationId: id },
    }),
  ]);
  const commentRecords = comments.map(jsonRecord);
  const resume = materials.find(
    (material) => material.materialType === 'resume',
  );
  const finalApprovalMaterialsCurrent =
    hasFinalApplicationApproval(application) &&
    finalApprovalMaterialSnapshotMatches(
      application,
      finalApprovalMaterials(materials),
    ) &&
    Boolean(resume?.pdfDigest) &&
    (await finalApprovalSuccessAuditExists(application, verifiedSubject));

  return {
    application: jsonRecord(application),
    comments: commentRecords,
    finalApprovalMaterialsCurrent,
    materials: materials.map((material) => ({
      ...material,
      reviewStatus: commentRecords.some(
        (comment) =>
          stringValue(comment.status) === 'reviewed' &&
          stringValue(comment.materialRecordId) === material.materialRecordId &&
          stringValue(comment.materialType) === material.materialType &&
          stringValue(comment.materialVersion) === material.materialVersion,
      )
        ? 'reviewed'
        : 'not_reviewed',
    })),
  };
}

async function saveCommentsFromForm(
  applicationId: string,
  form: FormData,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const reviewState = await ensureApplicationReviewMaterials(
    applicationId,
    verifiedSubject,
  );
  const materials = await reviewMaterialsForApplication(
    reviewState.application,
    reviewState.assets,
    verifiedSubject,
  );
  let created = 0;

  for (const material of materials) {
    const body = stringValue(form.get(`comment:${material.materialType}`));
    if (!body) continue;
    const comment = (await createPrivateRecord(
      'ApplicationMaterialComment',
      verifiedSubject,
      {
        applicationId,
        body,
        materialRecordId: material.materialRecordId,
        materialRecordType: material.materialRecordType,
        materialType: material.materialType,
        materialVersion: material.materialVersion,
        reviewerProfileId: verifiedSubject.profileId,
        reviewerUserId: verifiedSubject.userId,
        status: 'open',
      },
    )) as MutableRecord;
    await comment.save();
    created += 1;
  }

  return { created, reviewState };
}

export async function addApplicationMaterialComments(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const form = await request.formData();
  return {
    ...(await saveCommentsFromForm(applicationId, form, subject)),
    status: 'saved',
  };
}

export async function requestApplicationMaterialTweaks(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const form = await request.formData();
  const currentReviewState = await ensureApplicationReviewMaterials(
    applicationId,
    verifiedSubject,
  );
  if (
    applicationMaterialsAreLockedOrLeased(
      currentReviewState.application.status,
      currentReviewState.application,
    )
  ) {
    error(
      409,
      'Submitted or closed applications cannot be reopened for material changes.',
    );
  }
  const { created, reviewState } = await saveCommentsFromForm(
    applicationId,
    form,
    verifiedSubject,
  );
  if (
    applicationMaterialsAreLockedOrLeased(
      reviewState.application.status,
      reviewState.application,
    )
  ) {
    error(
      409,
      'Submitted or closed applications cannot be reopened for material changes.',
    );
  }
  const currentStatus = String(reviewState.application.status ?? 'draft');
  const status =
    currentStatus === 'approved' ||
    currentStatus === 'submitting' ||
    currentStatus === 'manual_submission'
      ? 'awaiting_user'
      : 'application_drafting';
  const violation = validateApplicationStatusTransition({
    approvedByUserId: reviewState.application.approvedByUserId,
    currentStatus,
    nextStatus: status,
  });
  if (violation) error(400, violation);
  const updates: Record<string, unknown> = { status };
  clearApplicationApprovalFields(updates);
  if (!(await commitApplicationIfCurrent(reviewState.application, updates))) {
    error(
      409,
      'Application changed before material revisions could be requested. Reload and review the current application.',
    );
  }
  await syncApplicationWorkflowTasks(reviewState.application);
  return { commentsCreated: created, status: 'revision_requested' };
}

export async function markApplicationMaterialReviewed(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const form = await request.formData();
  const { created, reviewState } = await saveCommentsFromForm(
    applicationId,
    form,
    verifiedSubject,
  );
  const materialType = stringValue(form.get('materialType'));
  const materials = await reviewMaterialsForApplication(
    reviewState.application,
    reviewState.assets,
    verifiedSubject,
  );
  const material = materials.find(
    (candidate) => candidate.materialType === materialType,
  );
  if (!material) {
    error(400, 'Choose an application material to mark reviewed.');
  }
  if (material.availability !== 'ready') {
    error(
      400,
      material.notice || 'Choose a reviewable application material first.',
    );
  }

  const review = (await createPrivateRecord(
    'ApplicationMaterialComment',
    verifiedSubject,
    {
      applicationId,
      body: '',
      materialRecordId: material.materialRecordId,
      materialRecordType: material.materialRecordType,
      materialType: material.materialType,
      materialVersion: material.materialVersion,
      resolvedAt: new Date(),
      reviewerProfileId: verifiedSubject.profileId,
      reviewerUserId: verifiedSubject.userId,
      status: 'reviewed',
    },
  )) as MutableRecord;
  await review.save();

  return {
    commentsCreated: created,
    materialType: material.materialType,
    status: 'material_reviewed',
  };
}

export async function approveApplicationForSubmission(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const user: ReviewActor = { id: verifiedSubject.userId };
  const form = await request.formData();
  if (
    stringValue(form.get('finalSubmissionIntent')) !==
    finalSubmissionApprovalKind
  ) {
    error(
      400,
      'Final submission approval requires the explicit final-submission action.',
    );
  }
  const { created, reviewState } = await saveCommentsFromForm(
    applicationId,
    form,
    verifiedSubject,
  );
  const violation = validateApplicationStatusTransition({
    approvedByUserId: user.id,
    currentStatus: reviewState.application.status,
    nextStatus: 'approved',
  });
  if (violation) {
    error(400, violation);
  }
  const approvedAt = new Date();
  const payload = {
    approvalNotes: stringValue(form.get('approvalNotes')),
    approvalScope: finalSubmissionApprovalKind,
    approvedAt,
    approvedByUserId: user.id,
    status: 'approved',
  };
  const materials = await reviewMaterialsForApplication(
    reviewState.application,
    reviewState.assets,
    verifiedSubject,
  );
  const approvedResume = materials.find(
    (material) => material.materialType === 'resume',
  );
  if (!approvedResume?.pdfDigest) {
    error(
      400,
      'Final submission approval requires a readable selected resume PDF.',
    );
  }
  const coverLetterRequested = ['custom', 'default', 'generate'].includes(
    stringValue(reviewState.application.coverLetterMode),
  );
  const approvedCoverLetter = materials.find(
    (material) => material.materialType === 'cover_letter',
  );
  if (
    coverLetterRequested &&
    (approvedCoverLetter?.availability !== 'ready' ||
      !approvedCoverLetter?.body)
  ) {
    error(
      400,
      'Final submission approval requires a readable requested cover letter.',
    );
  }
  // Do not save the loaded record wholesale: a scoped material edit can land
  // while this review form is open. The guarded database patch below makes
  // final approval contingent on that exact material fence still being current.
  const approvedApplication = {
    ...jsonRecord(reviewState.application),
    ...payload,
  } as Record<string, unknown>;
  recordFinalApplicationApproval(approvedApplication, {
    approvedAt,
    materials: finalApprovalMaterials(materials),
    userId: user.id,
  });
  // Establish a durable pending audit before persisting approval. A save
  // failure can therefore never leave an immutable success audit for approval
  // that was not actually recorded.
  await recordAgentAudit({
    application: approvedApplication,
    input: {
      action: 'record_final_submission_approval',
      materialSnapshotJson: approvedApplication.finalApprovalMaterialsJson,
    },
    output: {
      finalApprovalAt: approvedApplication.finalApprovalAt,
      finalApprovalKind: approvedApplication.finalApprovalKind,
      finalApprovedByUserId: approvedApplication.finalApprovedByUserId,
    },
    runType: 'application_final_approval_pending',
    status: 'pending',
    user,
  });
  if (
    !(await commitApplicationIfCurrent(reviewState.application, {
      approvalNotes: approvedApplication.approvalNotes,
      approvalScope: approvedApplication.approvalScope,
      approvedAt: approvedApplication.approvedAt,
      approvedByUserId: approvedApplication.approvedByUserId,
      finalApprovalAt: approvedApplication.finalApprovalAt,
      finalApprovalKind: approvedApplication.finalApprovalKind,
      finalApprovalMaterialsJson:
        approvedApplication.finalApprovalMaterialsJson,
      finalApprovedByUserId: approvedApplication.finalApprovedByUserId,
      status: 'approved',
    }))
  ) {
    error(
      409,
      'Application materials changed before final approval could be recorded. Reload and review the current materials.',
    );
  }
  await recordAgentAudit({
    application: reviewState.application,
    input: {
      action: 'record_final_submission_approval',
      materialSnapshotJson: reviewState.application.finalApprovalMaterialsJson,
    },
    output: {
      finalApprovalAt: reviewState.application.finalApprovalAt,
      finalApprovalKind: reviewState.application.finalApprovalKind,
      finalApprovedByUserId: reviewState.application.finalApprovedByUserId,
    },
    runType: 'application_final_approval',
    status: 'succeeded',
    user,
  });
  await syncApplicationWorkflowTasks(reviewState.application);

  // When auto-submit is active and the application is eligible, move it to
  // "Pending submission" and enqueue the worker job. No-op (stays approved)
  // when the feature is off or the application is ineligible. Best-effort:
  // never let an enqueue failure break the approval.
  try {
    const { maybeEnqueueAutoSubmitOnApproval } = await import(
      './auto-submit-application-job.js'
    );
    await maybeEnqueueAutoSubmitOnApproval(reviewState.application, { user });
  } catch {
    // Approval already persisted; auto-submit can be retried by an operator.
  }

  return { commentsCreated: created, status: 'approved' };
}

export async function recordApplicationSubmissionFromReview(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const form = await request.formData();
  await recordApplicationSubmission({
    applicationId,
    evidenceUrl: stringValue(form.get('submissionEvidenceUrl')),
    notes: stringValue(form.get('submissionNotes')),
    profileId: verifiedSubject.profileId,
    submissionMethod: stringValue(form.get('submissionMethod')),
    submittedByRole: stringValue(form.get('submittedByRole')),
    taskId: stringValue(form.get('taskId')),
    user: { id: verifiedSubject.userId },
  });
  return { status: 'submission_recorded' };
}

export async function recordApplicationSubmissionBlockerFromReview(
  applicationId: string,
  request: Request,
  subject: WorkspaceSubject,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  await requirePrivateApplication(applicationId, verifiedSubject);
  const form = await request.formData();
  await recordApplicationSubmissionBlocker({
    applicationId,
    blockerOwnerRole: stringValue(form.get('blockerOwnerRole')),
    blockerReason: stringValue(form.get('blockerReason')),
    blockerType: stringValue(form.get('blockerType')),
    notes: stringValue(form.get('blockerNotes')),
    taskId: stringValue(form.get('taskId')),
    user: { id: verifiedSubject.userId },
  });
  return { status: 'submission_blocked' };
}
