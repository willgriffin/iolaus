import type { FilesystemInterface } from '@happyvertical/files';
import type { ShortlistEntry } from '$lib/shortlist-contract.js';
import {
  getPrivateRecord,
  listPrivateRecords,
  type PrivateCollectionOptions,
  recordOwnedBySubject,
  requireWorkspaceSubject,
  type WorkspaceIdentitySubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { workspaceOwnershipClasses } from './workspace-ownership-backfill.js';

/**
 * Self-service export of the signed-in user's own workspace as one JSON
 * document. Every record is read through the private-record helpers, which
 * AND the verified tenant + owner + profile tuple into the query and re-check
 * it on every returned row, so no section can reach another tenant, another
 * owner or another profile. The caller supplies the verified subject; nothing
 * here accepts an id from a request.
 */

export const ACCOUNT_EXPORT_FORMAT = 'iolaus-account-export';
export const ACCOUNT_EXPORT_VERSION = 1;
export const SCREENING_QUESTION_CATEGORY = 'screening_questions';

type Row = Record<string, unknown>;

/** Section → candidate-owned classes. Every manifest class appears exactly once. */
export const accountExportSections: Readonly<
  Record<string, readonly string[]>
> = {
  profile: [
    'CandidateProfile',
    'CandidateProfileLink',
    'ResumeProfile',
    'ResumeLink',
  ],
  evidence: [
    'Achievement',
    'AchievementAttachment',
    'AchievementTag',
    'Attachment',
    'Duty',
    'DutyTag',
    'Education',
    'EducationTag',
    'EmploymentRole',
    'EmploymentRoleTag',
    'Experience',
    'ExperienceCompany',
    'ExperienceRole',
    'ExperienceTag',
    'Project',
    'ProjectAttachment',
    'ProjectTag',
    'SkillCategory',
    'SkillCategoryMember',
    'SkillGroup',
    'SkillGroupMember',
    'FactCandidate',
    'FactIntake',
  ],
  preferences: ['PreferenceRule', 'CandidateAnswer'],
  applications: ['Application', 'ApplicationMaterialComment'],
  materials: [
    'ResumeAsset',
    'ResumeVariant',
    'ResumeAchievement',
    'ResumeEducation',
    'ResumeOtherRole',
    'ResumePosition',
    'ResumeSkill',
    'ResumeSkillCategory',
    'ResumeSkillGroup',
    'ResumeTailoringConfig',
  ],
  decisions: ['Decision', 'DecisionTag', 'EvaluationScore'],
  assessments: [
    'OpportunityAssessment',
    'OpportunityIntelligenceRequest',
    'OpportunityIntelligenceResult',
  ],
  activity: ['Task', 'AgentRun', 'AdminAssistantTurn'],
};

export interface AccountExportFile {
  /** `pdf`, `markdown`, `text`, `html` or `attachment`. */
  kind: string;
  path: string;
  /** Whether the object currently exists in storage; null when not checked. */
  present: boolean | null;
}

export interface AccountExportAsset {
  /** Authenticated link, relative to the app origin; absent without a PDF. */
  downloadPath: string | null;
  files: AccountExportFile[];
  id: string;
  recordType: 'Attachment' | 'ResumeAsset';
  title: string;
}

/** Owner-only publication settings, immutable snapshots, and private files. */
export interface AccountExportPublicProfile {
  identity: {
    candidateProfileId: string;
    currentRevisionId: string | null;
    deletedAt: string | null;
    handle: string;
    revision: number;
  };
  revisions: Array<{
    baseRevision: number;
    createdAt: string;
    id: string;
    pdfBytes: number;
    pdfPath: string;
    pdfSha256: string;
    publishedRevision: number | null;
    snapshot: unknown;
    sourceProfileId: string;
    status: string;
  }>;
}

export interface AccountExport {
  account: { email: string | null };
  assets: AccountExportAsset[];
  counts: Record<string, number>;
  exportedAt: string;
  format: typeof ACCOUNT_EXPORT_FORMAT;
  notes: string[];
  publicProfile: AccountExportPublicProfile | null;
  screeningQuestions: Row[];
  shortlist: ShortlistEntry[];
  sections: Record<string, Record<string, Row[]>>;
  version: typeof ACCOUNT_EXPORT_VERSION;
  workspaceMode: string;
}

export interface AccountExportDependencies extends PrivateCollectionOptions {
  /** Used only to report whether each asset file is present. */
  filesystem?: Pick<FilesystemInterface, 'exists'>;
  now?: () => Date;
  /** Origin to prefix download paths with, e.g. `https://app.example`. */
  origin?: string;
  /** Optional while an older database has no public-profile tables. */
  publicProfileExport?: (
    subject: Pick<WorkspaceIdentitySubject, 'tenantId' | 'userId'>,
  ) => Promise<AccountExportPublicProfile | null>;
  /** Account-wide decisions; excludes internal idempotency receipts. */
  shortlistExport?: (
    subject: Pick<WorkspaceIdentitySubject, 'tenantId' | 'userId'>,
  ) => Promise<ShortlistEntry[]>;
  workspaceMode?: string;
}

const PAGE_SIZE = 500;

function plain(record: unknown): Row {
  const value = record as { toJSON?: () => Row } | null;
  const json =
    value && typeof value.toJSON === 'function'
      ? value.toJSON()
      : ({ ...(record as Row) } as Row);
  return JSON.parse(JSON.stringify(json)) as Row;
}

async function listAll(
  className: string,
  subject: WorkspaceSubject,
  options: PrivateCollectionOptions,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await listPrivateRecords(
      className,
      subject,
      { limit: PAGE_SIZE, offset, orderBy: 'id' },
      options,
    );
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function fileEntries(
  deps: AccountExportDependencies,
  candidates: Array<[string, unknown]>,
): Promise<AccountExportFile[]> {
  const files: AccountExportFile[] = [];
  for (const [kind, value] of candidates) {
    const path = str(value);
    if (!path) continue;
    let present: boolean | null = null;
    if (deps.filesystem) {
      try {
        present = await deps.filesystem.exists(path);
      } catch {
        present = null;
      }
    }
    files.push({ kind, path, present });
  }
  return files;
}

/**
 * Build the export for one verified candidate workspace subject. A subject
 * without a selected profile still exports account-wide data, so
 * a user who never onboarded can still confirm what is held about them.
 */
export async function buildAccountExport(
  identity: WorkspaceIdentitySubject,
  account: { email?: string | null },
  deps: AccountExportDependencies = {},
): Promise<AccountExport> {
  const exportedAt = (deps.now ?? (() => new Date()))().toISOString();
  const origin = (deps.origin ?? '').replace(/\/+$/u, '');
  const options: PrivateCollectionOptions = { db: deps.db };
  const sections: AccountExport['sections'] = {};
  const counts: Record<string, number> = {};
  const assets: AccountExportAsset[] = [];
  let screeningQuestions: Row[] = [];
  const publicProfile = deps.publicProfileExport
    ? await deps.publicProfileExport({
        tenantId: identity.tenantId,
        userId: identity.userId,
      })
    : null;
  const shortlist = deps.shortlistExport
    ? await deps.shortlistExport({
        tenantId: identity.tenantId,
        userId: identity.userId,
      })
    : [];
  counts.ShortlistEntryRecord = shortlist.length;
  const notes = [
    'Download links require you to be signed in and stop working once your account is deleted. Save the files you need first.',
    'AI usage accounting rows and the derived opportunity ranking cache are platform records and are not part of this export.',
  ];

  const subject: WorkspaceSubject | null = identity?.profileId
    ? requireWorkspaceSubject(identity)
    : null;
  for (const [section, classes] of Object.entries(accountExportSections)) {
    sections[section] = {};
    for (const className of classes) {
      let rows: Row[] = [];
      if (subject) {
        if (className === 'CandidateProfile') {
          const profile = await getPrivateRecord(
            className,
            subject.profileId,
            subject,
            options,
          );
          rows = profile ? [profile] : [];
        } else {
          rows = await listAll(className, subject, options);
        }
        // Defence in depth: never serialize a row the subject does not own.
        if (className !== 'CandidateProfile') {
          rows = rows.filter((row) => recordOwnedBySubject(row, subject));
        }
      }
      let serialised = rows.map(plain);
      if (className === 'PreferenceRule') {
        screeningQuestions = serialised.filter(
          (row) => row.category === SCREENING_QUESTION_CATEGORY,
        );
        serialised = serialised.filter(
          (row) => row.category !== SCREENING_QUESTION_CATEGORY,
        );
      }
      sections[section][className] = serialised;
      counts[className] = serialised.length;
    }
  }
  counts.ScreeningQuestion = screeningQuestions.length;

  for (const resume of sections.materials?.ResumeAsset ?? []) {
    const id = str(resume.id);
    const files = await fileEntries(deps, [
      ['pdf', resume.pdfPath],
      ['markdown', resume.markdownPath],
      ['text', resume.textPath],
      ['html', resume.htmlPath],
    ]);
    assets.push({
      downloadPath: files.some((file) => file.kind === 'pdf')
        ? `${origin}/admin/resume-assets/${encodeURIComponent(id)}/pdf`
        : null,
      files,
      id,
      recordType: 'ResumeAsset',
      title: str(resume.title),
    });
  }
  for (const attachment of sections.evidence?.Attachment ?? []) {
    const files = await fileEntries(deps, [
      ['attachment', attachment.filePath],
    ]);
    if (!files.length) continue;
    assets.push({
      downloadPath: null,
      files,
      id: str(attachment.id),
      recordType: 'Attachment',
      title: str(attachment.title),
    });
  }

  return {
    account: { email: str(account.email) || null },
    assets,
    counts,
    exportedAt,
    format: ACCOUNT_EXPORT_FORMAT,
    notes,
    publicProfile,
    screeningQuestions,
    shortlist,
    sections,
    version: ACCOUNT_EXPORT_VERSION,
    workspaceMode: deps.workspaceMode ?? 'shared',
  };
}

/** Classes in the ownership manifest that no export section lists. */
export function unexportedOwnershipClasses(): string[] {
  const exported = new Set(Object.values(accountExportSections).flat());
  return workspaceOwnershipClasses.filter(
    (className) => !exported.has(className),
  );
}

export function accountExportFilename(now: Date = new Date()): string {
  return `iolaus-export-${now.toISOString().slice(0, 10)}.json`;
}
