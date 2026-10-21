import { createHash, randomUUID } from 'node:crypto';
import { detectEngine } from '@happyvertical/smrt-core';
import {
  parseResumeImportBulletSections,
  parseResumeImportSkillEvidence,
  parseResumeImportStoredSkillEvidence,
  RESUME_IMPORT_STRUCTURE_MAX_BYTES,
  type ResumeImportSkillEvidence,
  type ResumeImportStoredSkillEvidence,
  stringifyResumeImportStructure,
} from '$lib/resume-import-structure.js';
import {
  createPrivateRecord,
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
} from './private-workspace.js';
import type { CandidateWorkspaceSubject } from './workspace-subject.js';

/** The ingestion host owns proposal persistence, revisions, and transactions.
 * This module only operates on the transaction it is given. */
export type ResumeImportKind =
  | 'experience'
  | 'education'
  | 'skill'
  | 'profile'
  | 'project';
export type ResumeImportDatabase = object;
type QueryableDatabase = ResumeImportDatabase & {
  query?: (sql: string, parameters?: unknown[]) => Promise<unknown>;
  url?: string;
};

export interface ResumeImportCandidateMatch {
  id: string;
  label: string;
  summary: string;
  /** Captured by the server and compared inside the apply transaction. */
  fingerprint: string;
}

export interface ResumeImportProposalEntry {
  id: string;
  kind: ResumeImportKind;
  fields: Record<string, string>;
  evidence?: readonly { page: number; text: string }[];
  candidateMatches?: ResumeImportCandidateMatch[];
}

export interface ResumeImportProposal {
  revision: string;
  entries: readonly ResumeImportProposalEntry[];
}

export interface ResumeImportApplyEntry {
  id: string;
  action: 'create' | 'merge' | 'skip';
  targetId?: string;
  fields: Record<string, string>;
}

export interface ResumeImportApplyInput {
  revision: string;
  entries: readonly ResumeImportApplyEntry[];
}

export interface ResumeImportApplyResult {
  createdIds: string[];
  mergedIds: string[];
  skippedIds: string[];
}

export class ResumeImportDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeImportDomainError';
  }
}

const allowedFields: Record<ResumeImportKind, readonly string[]> = {
  education: ['title', 'institution', 'startDate', 'endDate', 'detail'],
  experience: [
    'company',
    'title',
    'startDate',
    'endDate',
    'summary',
    'bullets',
    'bulletSections',
  ],
  profile: ['summary'],
  project: [
    'name',
    'url',
    'summary',
    'startDate',
    'endDate',
    'bullets',
    'proposalExperienceId',
    'bulletSections',
  ],
  skill: ['name'],
};

type RecordLike = Record<string, unknown> & {
  delete?: () => Promise<void>;
  id?: string;
  save?: () => Promise<void>;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveId(value: unknown, label: string): string {
  const id = text(value);
  if (
    !id ||
    id.length > 160 ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new ResumeImportDomainError(`Invalid ${label}.`);
  return id;
}

function bounded(value: string, label: string, limit = 20_000): string {
  if (value.length > limit)
    throw new ResumeImportDomainError(`${label} is too long.`);
  return value;
}

function boundedStructure(value: string, label: string): string {
  if (
    new TextEncoder().encode(value).byteLength >
    RESUME_IMPORT_STRUCTURE_MAX_BYTES
  )
    throw new ResumeImportDomainError(`${label} is too long.`);
  return value;
}

type ParsedDate = {
  date: Date | null;
  precision: 'day' | 'month' | 'year' | 'present';
};

/** Only accepts ISO date precision supplied by the review UI; never guesses it. */
export function parseResumeImportDate(value: string, end = false): ParsedDate {
  const input = text(value);
  if (!input) return { date: null, precision: end ? 'present' : 'year' };
  const match = input.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u);
  if (!match)
    throw new ResumeImportDomainError(
      'Dates must be YYYY, YYYY-MM, or YYYY-MM-DD.',
    );
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new ResumeImportDomainError('Invalid calendar date.');
  return { date, precision: match[3] ? 'day' : match[2] ? 'month' : 'year' };
}

export function validateResumeImportFields(
  kind: ResumeImportKind,
  fields: Record<string, string>,
  proposalMetadata = false,
) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new ResumeImportDomainError('Entry fields must be an object.');
  const allowed = new Set(allowedFields[kind]);
  if (proposalMetadata && kind === 'skill') allowed.add('skillEvidence');
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!allowed.has(key))
      throw new ResumeImportDomainError(`Unknown ${kind} field: ${key}.`);
    if (typeof raw !== 'string')
      throw new ResumeImportDomainError(`Invalid ${kind} field: ${key}.`);
    const label = `${key} field`;
    const trimmed = raw.trim();
    const value =
      key === 'bulletSections' || key === 'skillEvidence'
        ? boundedStructure(trimmed, label)
        : bounded(trimmed, label, key === 'bullets' ? 50_000 : 20_000);
    // Editable review DTOs send blank optional JSON fields. Treat those as
    // absent so legacy unsectioned bullets remain compatible.
    if ((key === 'bulletSections' || key === 'skillEvidence') && !value)
      continue;
    values[key] = value;
  }
  if (kind === 'experience') {
    for (const key of ['company', 'title'] as const)
      if (!values[key])
        throw new ResumeImportDomainError(`Experience ${key} is required.`);
  }
  if (kind === 'education' && (!values.title || !values.institution))
    throw new ResumeImportDomainError(
      'Education title and institution are required.',
    );
  if (kind === 'skill' && !values.name)
    throw new ResumeImportDomainError('Skill name is required.');
  if (kind === 'profile' && !values.summary)
    throw new ResumeImportDomainError('Profile summary is required.');
  if (kind === 'project') {
    if (!values.name)
      throw new ResumeImportDomainError('Project name is required.');
    if (values.url) {
      let url: URL;
      try {
        url = new URL(values.url);
      } catch {
        throw new ResumeImportDomainError('Project URL must be HTTP or HTTPS.');
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new ResumeImportDomainError('Project URL must be HTTP or HTTPS.');
      if (url.username || url.password)
        throw new ResumeImportDomainError(
          'Project URL must not include credentials.',
        );
    }
  }
  for (const key of ['startDate', 'endDate'])
    if (key in values) parseResumeImportDate(values[key], key === 'endDate');
  try {
    if (values.bulletSections !== undefined)
      parseResumeImportBulletSections(values.bulletSections);
    if (values.skillEvidence !== undefined)
      parseResumeImportSkillEvidence(values.skillEvidence);
  } catch (cause) {
    throw new ResumeImportDomainError(
      cause instanceof Error
        ? cause.message
        : 'Invalid structured review data.',
    );
  }
  return values;
}

/** Validate extracted proposal content before the host persists a revision. */
export function validateResumeImportProposalEntries(
  entries: readonly ResumeImportProposalEntry[],
): ResumeImportProposalEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    const id = positiveId(entry.id, 'proposal entry ID');
    if (seen.has(id))
      throw new ResumeImportDomainError(
        'Proposal contains duplicate entry IDs.',
      );
    seen.add(id);
    if (!Object.hasOwn(allowedFields, entry.kind))
      throw new ResumeImportDomainError('Unknown resume import entry kind.');
    if (entry.kind === 'project' && entry.fields.proposalExperienceId)
      positiveId(
        entry.fields.proposalExperienceId,
        'project parent proposal entry ID',
      );
    return {
      ...entry,
      id,
      ...(entry.evidence === undefined
        ? {}
        : {
            evidence: entry.evidence.map((item) => {
              if (
                !item ||
                !Number.isInteger(item.page) ||
                item.page < 1 ||
                typeof item.text !== 'string' ||
                !item.text.trim() ||
                item.text.length > 20_000
              )
                throw new ResumeImportDomainError(
                  'Proposal evidence is invalid.',
                );
              return { page: item.page, text: item.text.trim() };
            }),
          }),
      fields: validateResumeImportFields(entry.kind, entry.fields, true),
    };
  });
}

/** Pure validation for the handler's preview fence; no database reads occur. */
export function validateResumeImportApply(
  proposal: ResumeImportProposal,
  input: ResumeImportApplyInput,
): void {
  if (text(input.revision) !== text(proposal.revision))
    throw new ResumeImportDomainError('Proposal revision is stale.');
  const entries = validateResumeImportProposalEntries(proposal.entries);
  const proposalById = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const decision of input.entries) {
    const id = positiveId(decision.id, 'entry ID');
    if (seen.has(id))
      throw new ResumeImportDomainError(
        'Apply input contains duplicate entry IDs.',
      );
    seen.add(id);
    const entry = proposalById.get(id);
    if (!entry)
      throw new ResumeImportDomainError(
        'Apply entry was not in the server proposal.',
      );
    if (!['create', 'merge', 'skip'].includes(decision.action))
      throw new ResumeImportDomainError('Unknown apply action.');
    if (decision.action !== 'skip')
      validateResumeImportFields(entry.kind, decision.fields);
    if (entry.kind === 'profile' && decision.action === 'create')
      throw new ResumeImportDomainError(
        'Profile entries must merge into the captured profile.',
      );
    if (decision.action === 'merge') {
      const targetId = positiveId(decision.targetId, 'merge target ID');
      if (
        !entry.candidateMatches?.some((candidate) => candidate.id === targetId)
      )
        throw new ResumeImportDomainError(
          'Merge target was not captured by the server proposal.',
        );
    }
    if (entry.kind === 'project' && entry.fields.proposalExperienceId) {
      const parent = proposalById.get(entry.fields.proposalExperienceId);
      if (parent?.kind !== 'experience')
        throw new ResumeImportDomainError(
          'Project parent proposal entry is invalid.',
        );
    }
  }
  if (seen.size !== proposalById.size)
    throw new ResumeImportDomainError(
      'Apply input must decide every proposal entry exactly once.',
    );
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ownedRows(
  className: string,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
) {
  return (await listPrivateRecords(
    className,
    requireWorkspaceSubject(subject),
    { limit: 2000, orderBy: 'sortOrder ASC' },
    { db },
  )) as RecordLike[];
}

async function currentMatches(
  kind: ResumeImportKind,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
): Promise<ResumeImportCandidateMatch[]> {
  const owned = requireWorkspaceSubject(subject);
  if (kind === 'profile') {
    const row = (await getPrivateRecord(
      'CandidateProfile',
      owned.profileId,
      owned,
      { db },
    )) as RecordLike | null;
    if (!row) return [];
    return [
      {
        id: owned.profileId,
        label: text(row.name) || 'Profile',
        summary: text(row.summary),
        fingerprint: fingerprint({ summary: text(row.summary) }),
      },
    ];
  }
  if (kind === 'education') {
    return (await ownedRows('Education', owned, db)).map((row) => ({
      id: positiveId(row.id, 'education ID'),
      label: `${text(row.title)} — ${text(row.institution)}`,
      summary: text(row.detail),
      fingerprint: fingerprint({
        title: text(row.title),
        institution: text(row.institution),
        detail: text(row.detail),
        startDate: row.startDate,
        endDate: row.endDate,
      }),
    }));
  }
  if (kind === 'skill') {
    const [groups, members] = await Promise.all([
      ownedRows('SkillGroup', owned, db),
      ownedRows('SkillGroupMember', owned, db),
    ]);
    return groups.map((row) => ({
      id: positiveId(row.id, 'skill group ID'),
      label: text(row.label),
      summary: String(
        members
          .filter((member) => member.groupId === row.id)
          .map((member) => member.tagId)
          .join(','),
      ),
      fingerprint: fingerprint({
        label: text(row.label),
        evidenceJson: text(row.evidenceJson),
        members: members
          .filter((member) => member.groupId === row.id)
          .map((member) => String(member.tagId))
          .sort(),
      }),
    }));
  }
  if (kind === 'project') {
    const duties = await ownedRows('Duty', owned, db);
    return (await ownedRows('Project', owned, db)).map((row) => ({
      id: positiveId(row.id, 'project ID'),
      label: text(row.name),
      summary: text(row.summary),
      fingerprint: fingerprint({
        name: text(row.name),
        url: text(row.url),
        summary: text(row.summary),
        startDate: row.startDate,
        endDate: row.endDate,
        startPrecision: row.startPrecision,
        endPrecision: row.endPrecision,
        experienceId: text(row.experienceId),
        duties: duties
          .filter((duty) => duty.projectId === row.id)
          .map((duty) => ({
            title: text(duty.title),
            body: text(duty.body),
            sortOrder: duty.sortOrder,
          })),
      }),
    }));
  }
  const [experiences, companies, roles, duties] = await Promise.all([
    ownedRows('Experience', owned, db),
    ownedRows('ExperienceCompany', owned, db),
    ownedRows('ExperienceRole', owned, db),
    ownedRows('Duty', owned, db),
  ]);
  return experiences.map((row) => {
    const id = positiveId(row.id, 'experience ID');
    const company = companies.find(
      (join) => join.experienceId === id && join.isPrimary !== false,
    );
    const role = roles.find(
      (join) => join.experienceId === id && join.isPrimary !== false,
    );
    const related = {
      summary: text(row.summary),
      startDate: row.startDate,
      endDate: row.endDate,
      startPrecision: row.startPrecision,
      endPrecision: row.endPrecision,
      company: text(company?.companyNameSnapshot),
      title: text(role?.titleSnapshot),
      duties: duties
        .filter((duty) => duty.experienceId === id && !text(duty.projectId))
        .map((duty) => ({
          title: text(duty.title),
          body: text(duty.body),
          sortOrder: duty.sortOrder,
        })),
    };
    return {
      id,
      label: `${text(role?.titleSnapshot)} — ${text(company?.companyNameSnapshot)}`,
      summary: text(row.summary),
      fingerprint: fingerprint(related),
    };
  });
}

/**
 * PostgreSQL does not make a prior read a write fence. Lock the exact owned
 * rows, in a fixed table order, before the apply-side fingerprint re-read.
 * SQLite's write transaction already serializes this path and rejects FOR
 * UPDATE syntax, so it intentionally needs no additional statement.
 */
async function lockMergeTarget(
  kind: ResumeImportKind,
  targetId: string,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
) {
  const database = db as QueryableDatabase;
  if (
    !database.query ||
    !database.url ||
    detectEngine(database.url) !== 'postgres'
  )
    return;
  const query = database.query.bind(database);
  const owned = requireWorkspaceSubject(subject);
  const ownership = [owned.tenantId, owned.userId, owned.profileId];
  const lock = async (
    table:
      | 'candidate_profiles'
      | 'education'
      | 'experience_companies'
      | 'experience_roles'
      | 'experiences'
      | 'duties'
      | 'skill_group_members'
      | 'skill_groups'
      | 'projects',
    predicate: string,
    parameters: unknown[],
  ) => {
    await query(
      `SELECT id FROM ${table} WHERE ${predicate} FOR UPDATE`,
      parameters,
    );
  };
  if (kind === 'profile')
    return await lock(
      'candidate_profiles',
      'id = ? AND tenant_id = ? AND owner_user_id = ?',
      [targetId, owned.tenantId, owned.userId],
    );
  if (kind === 'education')
    return await lock(
      'education',
      'id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
      [targetId, ...ownership],
    );
  if (kind === 'skill') {
    await lock(
      'skill_group_members',
      'group_id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
      [targetId, ...ownership],
    );
    return await lock(
      'skill_groups',
      'id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
      [targetId, ...ownership],
    );
  }
  if (kind === 'project') {
    await lock(
      'duties',
      'project_id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
      [targetId, ...ownership],
    );
    return await lock(
      'projects',
      'id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
      [targetId, ...ownership],
    );
  }
  await lock(
    'duties',
    'experience_id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
    [targetId, ...ownership],
  );
  await lock(
    'experience_companies',
    'experience_id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
    [targetId, ...ownership],
  );
  await lock(
    'experience_roles',
    'experience_id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
    [targetId, ...ownership],
  );
  await lock(
    'experiences',
    'id = ? AND tenant_id = ? AND owner_user_id = ? AND candidate_profile_id = ?',
    [targetId, ...ownership],
  );
}

/** Capture candidates while producing a proposal. Persist this snapshot with it. */
export async function captureResumeImportMatches(options: {
  db: ResumeImportDatabase;
  subject: CandidateWorkspaceSubject;
  entries: readonly Pick<ResumeImportProposalEntry, 'id' | 'kind'>[];
}) {
  const subject = requireWorkspaceSubject(options.subject);
  return await Promise.all(
    options.entries.map(async (entry) => ({
      id: positiveId(entry.id, 'proposal entry ID'),
      candidateMatches: await currentMatches(entry.kind, subject, options.db),
    })),
  );
}

function slug(value: string) {
  const result = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 80);
  if (!result)
    throw new ResumeImportDomainError(
      'A name must contain letters or numbers.',
    );
  return result;
}

function importedSkillGroupKey(value: string) {
  let prefix = 'skill';
  try {
    prefix = slug(value).slice(0, 60);
  } catch {
    // A private stable key must not reject a reviewed non-ASCII skill label.
  }
  return `resume-import:${prefix}-${createHash('sha256').update(normalized(value)).digest('hex')}`;
}

type ReviewedDuty = { title: string; body: string };

function normalized(value: string) {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

/** Section labels are metadata on Duties; unsectioned legacy bullets remain valid. */
function reviewedDuties(fields: Record<string, string>): ReviewedDuty[] {
  const duties: ReviewedDuty[] = [];
  if (fields.bulletSections !== undefined) {
    for (const section of parseResumeImportBulletSections(
      fields.bulletSections,
    ))
      for (const body of section.bullets)
        duties.push({ title: section.title, body });
  }
  if (fields.bullets !== undefined)
    for (const body of fields.bullets.split(/\r?\n/u)) {
      const trimmed = body.trim();
      if (trimmed) duties.push({ title: '', body: trimmed });
    }
  const seen = new Set<string>();
  return duties.filter((duty) => {
    const key = `${normalized(duty.title)}\u0000${normalized(duty.body)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function precisionDate(value: unknown, precision: unknown) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  if (precision === 'year') return year;
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (precision === 'month') return `${year}-${month}`;
  return `${year}-${month}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

type AppliedExperience = {
  experienceId: string;
  company: string;
  role: string;
  roleStartDate?: string;
  roleEndDate?: string;
};

async function appliedExperience(
  experienceId: string,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
): Promise<AppliedExperience> {
  const owned = requireWorkspaceSubject(subject);
  const [experiences, companies, roles] = await Promise.all([
    ownedRows('Experience', owned, db),
    ownedRows('ExperienceCompany', owned, db),
    ownedRows('ExperienceRole', owned, db),
  ]);
  if (!experiences.some((experience) => experience.id === experienceId))
    throw new ResumeImportDomainError('Applied experience was not found.');
  const company = companies.find(
    (row) => row.experienceId === experienceId && row.isPrimary !== false,
  );
  const role = roles.find(
    (row) => row.experienceId === experienceId && row.isPrimary !== false,
  );
  return {
    experienceId,
    company: text(company?.companyNameSnapshot),
    role: text(role?.titleSnapshot),
    ...(precisionDate(role?.startDate, role?.startPrecision)
      ? { roleStartDate: precisionDate(role?.startDate, role?.startPrecision) }
      : {}),
    ...(precisionDate(role?.endDate, role?.endPrecision)
      ? { roleEndDate: precisionDate(role?.endDate, role?.endPrecision) }
      : {}),
  };
}

function supportedQuote(
  observation: ResumeImportSkillEvidence,
  parent: ResumeImportProposalEntry,
) {
  const quote = normalized(observation.quote);
  return parent.evidence?.some(
    (item) =>
      item.page === observation.page && normalized(item.text).includes(quote),
  );
}

function resolveSkillEvidence(
  value: string | undefined,
  proposalById: ReadonlyMap<string, ResumeImportProposalEntry>,
  experiences: ReadonlyMap<string, AppliedExperience>,
): ResumeImportStoredSkillEvidence[] {
  if (value === undefined) return [];
  return parseResumeImportSkillEvidence(value).map((observation) => {
    const parent = proposalById.get(observation.proposalExperienceId);
    if (parent?.kind !== 'experience')
      throw new ResumeImportDomainError(
        'Skill evidence references an invalid proposal experience.',
      );
    if (!supportedQuote(observation, parent))
      throw new ResumeImportDomainError(
        'Skill evidence quote is not supported by its proposal evidence.',
      );
    const experience = experiences.get(observation.proposalExperienceId);
    // A skipped role retains its quoted observation but never gains a dangling
    // native relationship or role dates.
    return experience ? { ...observation, ...experience } : observation;
  });
}

function dedupeSkillEvidence(
  existing: ResumeImportStoredSkillEvidence[],
  additions: ResumeImportStoredSkillEvidence[],
) {
  const seen = new Set<string>();
  return [...existing, ...additions].filter((observation) => {
    const key = fingerprint({
      // Proposal IDs are ordinal within one import (for example
      // `experience-1`), so they cannot identify a role across imports.
      // The server-resolved owned ID keeps repeat applies idempotent without
      // collapsing identical evidence from distinct return stints.
      experience: observation.experienceId ?? observation.proposalExperienceId,
      quote: normalized(observation.quote),
      page: observation.page,
      startDate: observation.startDate,
      endDate: observation.endDate,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergedSkillEvidenceJson(
  current: unknown,
  additions: ResumeImportStoredSkillEvidence[],
) {
  let existing: ResumeImportStoredSkillEvidence[];
  try {
    existing = parseResumeImportStoredSkillEvidence(text(current) || '[]');
  } catch (cause) {
    throw new ResumeImportDomainError(
      cause instanceof Error
        ? cause.message
        : 'Stored skill evidence is invalid.',
    );
  }
  try {
    return stringifyResumeImportStructure(
      dedupeSkillEvidence(existing, additions),
    );
  } catch (cause) {
    throw new ResumeImportDomainError(
      cause instanceof Error
        ? cause.message
        : 'Stored skill evidence is invalid.',
    );
  }
}

async function saveOwned(record: RecordLike, changes: Record<string, unknown>) {
  Object.assign(record, changes);
  if (typeof record.save !== 'function')
    throw new ResumeImportDomainError('Owned record cannot be saved.');
  await record.save();
  return positiveId(record.id, 'record ID');
}

async function applyCreate(
  kind: ResumeImportKind,
  fields: Record<string, string>,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
  parentExperienceId?: string,
  skillEvidence: ResumeImportStoredSkillEvidence[] = [],
) {
  const owned = requireWorkspaceSubject(subject);
  if (kind === 'profile') {
    throw new ResumeImportDomainError(
      'Profile entries must merge into the captured profile.',
    );
  }
  if (kind === 'project') {
    const start = parseResumeImportDate(fields.startDate ?? '');
    const end = parseResumeImportDate(fields.endDate ?? '', true);
    const project = await createPrivateRecord(
      'Project',
      owned,
      {
        experienceId: parentExperienceId ?? '',
        projectKey: `resume-import:${randomUUID()}`,
        name: fields.name,
        url: fields.url ?? '',
        summary: fields.summary ?? '',
        startDate: start.date,
        endDate: end.date,
        startPrecision: start.precision,
        endPrecision: end.precision,
        sortOrder: 0,
        useOnResume: true,
      },
      { db },
    );
    const projectId = positiveId(project.id, 'project ID');
    for (const [sortOrder, duty] of reviewedDuties(fields).entries())
      await createPrivateRecord(
        'Duty',
        owned,
        {
          experienceId: parentExperienceId ?? '',
          projectId,
          title: duty.title,
          body: duty.body,
          sortOrder,
          useOnResume: true,
        },
        { db },
      );
    return projectId;
  }
  if (kind === 'education') {
    const start = parseResumeImportDate(fields.startDate ?? '');
    const end = parseResumeImportDate(fields.endDate ?? '', true);
    const row = await createPrivateRecord(
      'Education',
      owned,
      {
        title: fields.title,
        institution: fields.institution,
        detail: fields.detail ?? '',
        startDate: start.date,
        endDate: end.date,
        startPrecision: start.precision,
        endPrecision: end.precision,
        sortOrder: 0,
        useOnResume: true,
      },
      { db },
    );
    return positiveId(row.id, 'education ID');
  }
  if (kind === 'skill') {
    // Skill labels are private candidate content. Do not manufacture shared
    // catalog tags from arbitrary extracted resume text. The resume assembler
    // retains a labeled SkillGroup even when it has no catalog members.
    const group = await createPrivateRecord(
      'SkillGroup',
      owned,
      {
        groupKey: importedSkillGroupKey(fields.name),
        label: fields.name,
        evidenceJson: stringifyResumeImportStructure(skillEvidence),
        sortOrder: 0,
        useOnResume: true,
      },
      { db },
    );
    return positiveId(group.id, 'skill group ID');
  }
  const start = parseResumeImportDate(fields.startDate ?? '');
  const end = parseResumeImportDate(fields.endDate ?? '', true);
  const experience = await createPrivateRecord(
    'Experience',
    owned,
    {
      // Native reviewed action idempotency owns replay. A fresh key preserves
      // separate return stints at the same company and title.
      experienceKey: `resume-import:${randomUUID()}`,
      summary: fields.summary ?? '',
      startDate: start.date,
      endDate: end.date,
      startPrecision: start.precision,
      endPrecision: end.precision,
      sortOrder: 0,
      useOnResume: true,
    },
    { db },
  );
  const experienceId = positiveId(experience.id, 'experience ID');
  await Promise.all([
    createPrivateRecord(
      'ExperienceCompany',
      owned,
      {
        experienceId,
        companyId: '',
        companyNameSnapshot: fields.company,
        isPrimary: true,
        relationship: 'employer',
        sortOrder: 0,
      },
      { db },
    ),
    createPrivateRecord(
      'ExperienceRole',
      owned,
      {
        experienceId,
        roleId: '',
        titleSnapshot: fields.title,
        startDate: start.date,
        endDate: end.date,
        startPrecision: start.precision,
        endPrecision: end.precision,
        summary: fields.summary ?? '',
        isPrimary: true,
        sortOrder: 0,
      },
      { db },
    ),
  ]);
  // Private-record creation relies on the active native tenant context. Keep
  // the writes ordered so a large reviewed section cannot race that context on
  // SQLite while the surrounding apply transaction remains atomic.
  for (const [sortOrder, duty] of reviewedDuties(fields).entries())
    await createPrivateRecord(
      'Duty',
      owned,
      {
        experienceId,
        title: duty.title,
        body: duty.body,
        sortOrder,
        useOnResume: true,
      },
      { db },
    );
  return experienceId;
}

async function applyMerge(
  kind: ResumeImportKind,
  targetId: string,
  fields: Record<string, string>,
  subject: CandidateWorkspaceSubject,
  db: ResumeImportDatabase,
  parentExperienceId?: string,
  skillEvidence: ResumeImportStoredSkillEvidence[] = [],
) {
  const owned = requireWorkspaceSubject(subject);
  if (kind === 'experience') {
    const row = (await getPrivateRecord('Experience', targetId, owned, {
      db,
    })) as RecordLike | null;
    if (!row)
      throw new ResumeImportDomainError('Experience target was not found.');
    const start = parseResumeImportDate(fields.startDate ?? '');
    const end = parseResumeImportDate(fields.endDate ?? '', true);
    const id = await saveOwned(row, {
      summary: fields.summary ?? row.summary,
      startDate: fields.startDate === undefined ? row.startDate : start.date,
      endDate: fields.endDate === undefined ? row.endDate : end.date,
      startPrecision:
        fields.startDate === undefined ? row.startPrecision : start.precision,
      endPrecision:
        fields.endDate === undefined ? row.endPrecision : end.precision,
    });
    const [companies, roles] = await Promise.all([
      ownedRows('ExperienceCompany', owned, db),
      ownedRows('ExperienceRole', owned, db),
    ]);
    const company = companies.find(
      (join) => join.experienceId === id && join.isPrimary !== false,
    );
    const role = roles.find(
      (join) => join.experienceId === id && join.isPrimary !== false,
    );
    if (company)
      await saveOwned(company, { companyNameSnapshot: fields.company });
    else
      await createPrivateRecord(
        'ExperienceCompany',
        owned,
        {
          experienceId: id,
          companyId: '',
          companyNameSnapshot: fields.company,
          relationship: 'employer',
          isPrimary: true,
          sortOrder: 0,
        },
        { db },
      );
    if (role)
      await saveOwned(role, {
        titleSnapshot: fields.title,
        startDate: fields.startDate === undefined ? role.startDate : start.date,
        endDate: fields.endDate === undefined ? role.endDate : end.date,
        startPrecision:
          fields.startDate === undefined
            ? role.startPrecision
            : start.precision,
        endPrecision:
          fields.endDate === undefined ? role.endPrecision : end.precision,
        summary: fields.summary ?? role.summary,
      });
    else
      await createPrivateRecord(
        'ExperienceRole',
        owned,
        {
          experienceId: id,
          roleId: '',
          titleSnapshot: fields.title,
          startDate: start.date,
          endDate: end.date,
          startPrecision: start.precision,
          endPrecision: end.precision,
          summary: fields.summary ?? '',
          isPrimary: true,
          sortOrder: 0,
        },
        { db },
      );
    if (fields.bullets !== undefined || fields.bulletSections !== undefined) {
      const duties = (await ownedRows('Duty', owned, db))
        .filter((duty) => duty.experienceId === id && !text(duty.projectId))
        .sort(
          (left, right) => Number(left.sortOrder) - Number(right.sortOrder),
        );
      const reviewed = reviewedDuties(fields);
      const titleForBody = new Map<string, string>();
      for (const duty of reviewed) {
        const body = normalized(duty.body);
        if (!titleForBody.has(body)) titleForBody.set(body, duty.title);
      }
      // Deduplicate by body so a reviewed section does not duplicate a legacy
      // bullet merely because it adds a heading. A blank legacy heading adopts
      // that first reviewed heading; an existing nonblank title is user data.
      const existing = duties.map((duty) => ({
        duty,
        title:
          text(duty.title) ||
          titleForBody.get(normalized(text(duty.body))) ||
          '',
      }));
      const knownBodies = new Set(
        existing.map(({ duty }) => normalized(text(duty.body))),
      );
      const additions: ReviewedDuty[] = [];
      for (const duty of reviewed) {
        const body = normalized(duty.body);
        if (knownBodies.has(body)) continue;
        knownBodies.add(body);
        additions.push(duty);
      }
      // A heading may occur in several review sections. Rebuild sort orders by
      // first appearance so every same-heading group stays contiguous while
      // retaining the existing groups' order.
      const titles: string[] = [];
      for (const title of [
        ...existing.map((entry) => entry.title),
        ...additions.map((entry) => entry.title),
      ])
        if (!titles.includes(title)) titles.push(title);
      let sortOrder = 0;
      for (const title of titles) {
        for (const entry of existing.filter((item) => item.title === title))
          await saveOwned(entry.duty, { title, sortOrder: sortOrder++ });
        for (const duty of additions.filter((item) => item.title === title))
          await createPrivateRecord(
            'Duty',
            owned,
            {
              experienceId: id,
              title,
              body: duty.body,
              sortOrder: sortOrder++,
              useOnResume: true,
            },
            { db },
          );
      }
    }
    return id;
  }
  if (kind === 'project') {
    const row = (await getPrivateRecord('Project', targetId, owned, {
      db,
    })) as RecordLike | null;
    if (!row)
      throw new ResumeImportDomainError('Project target was not found.');
    const start = parseResumeImportDate(fields.startDate ?? '');
    const end = parseResumeImportDate(fields.endDate ?? '', true);
    const projectId = await saveOwned(row, {
      name: fields.name,
      url: fields.url ?? '',
      summary: fields.summary ?? '',
      startDate: fields.startDate === undefined ? row.startDate : start.date,
      endDate: fields.endDate === undefined ? row.endDate : end.date,
      startPrecision:
        fields.startDate === undefined ? row.startPrecision : start.precision,
      endPrecision:
        fields.endDate === undefined ? row.endPrecision : end.precision,
      ...(parentExperienceId ? { experienceId: parentExperienceId } : {}),
    });
    const duties = (await ownedRows('Duty', owned, db)).filter(
      (duty) => duty.projectId === projectId,
    );
    if (parentExperienceId) {
      await Promise.all(
        duties.map((duty) =>
          saveOwned(duty, { experienceId: parentExperienceId }),
        ),
      );
    }
    if (fields.bullets !== undefined || fields.bulletSections !== undefined) {
      await Promise.all(
        duties.map(async (duty) => {
          if (typeof duty.delete !== 'function')
            throw new ResumeImportDomainError(
              'Project duty cannot be deleted.',
            );
          await duty.delete();
        }),
      );
      for (const [sortOrder, duty] of reviewedDuties(fields).entries())
        await createPrivateRecord(
          'Duty',
          owned,
          {
            experienceId: parentExperienceId ?? text(row.experienceId),
            projectId,
            title: duty.title,
            body: duty.body,
            sortOrder,
            useOnResume: true,
          },
          { db },
        );
    }
    return projectId;
  }
  const className =
    kind === 'education'
      ? 'Education'
      : kind === 'skill'
        ? 'SkillGroup'
        : 'CandidateProfile';
  const row = (await getPrivateRecord(className, targetId, owned, {
    db,
  })) as RecordLike | null;
  if (!row) throw new ResumeImportDomainError(`${kind} target was not found.`);
  if (kind === 'education') {
    const start = parseResumeImportDate(fields.startDate ?? '');
    const end = parseResumeImportDate(fields.endDate ?? '', true);
    return await saveOwned(row, {
      title: fields.title,
      institution: fields.institution,
      detail: fields.detail ?? '',
      startDate: fields.startDate === undefined ? row.startDate : start.date,
      endDate: fields.endDate === undefined ? row.endDate : end.date,
      startPrecision:
        fields.startDate === undefined ? row.startPrecision : start.precision,
      endPrecision:
        fields.endDate === undefined ? row.endPrecision : end.precision,
    });
  }
  return await saveOwned(
    row,
    kind === 'skill'
      ? {
          label: fields.name,
          evidenceJson: mergedSkillEvidenceJson(
            row.evidenceJson,
            skillEvidence,
          ),
        }
      : { summary: fields.summary },
  );
}

/**
 * Apply a review decision inside the caller's already-open native transaction.
 * The caller must atomically journal completion with this result.
 */
export async function applyResumeImportDomain(options: {
  db: ResumeImportDatabase;
  subject: CandidateWorkspaceSubject;
  proposal: ResumeImportProposal;
  input: ResumeImportApplyInput;
}): Promise<ResumeImportApplyResult> {
  const subject = requireWorkspaceSubject(options.subject);
  validateResumeImportApply(options.proposal, options.input);
  const validatedProposal = validateResumeImportProposalEntries(
    options.proposal.entries,
  );
  const proposalById = new Map(
    validatedProposal.map((entry) => [entry.id, entry]),
  );
  if (proposalById.size !== options.proposal.entries.length)
    throw new ResumeImportDomainError('Proposal contains duplicate entry IDs.');
  const seen = new Set<string>();
  const decisionById = new Map(
    options.input.entries.map((entry) => [entry.id, entry]),
  );
  const appliedExperienceIds = new Map<string, string>();
  const appliedExperiences = new Map<string, AppliedExperience>();
  const result: ResumeImportApplyResult = {
    createdIds: [],
    mergedIds: [],
    skippedIds: [],
  };
  for (const decision of [...options.input.entries].sort((left, right) => {
    const order = (kind: ResumeImportKind | undefined) =>
      kind === 'experience'
        ? 0
        : kind === 'skill'
          ? 1
          : kind === 'project'
            ? 2
            : 1;
    return (
      order(proposalById.get(left.id)?.kind) -
      order(proposalById.get(right.id)?.kind)
    );
  })) {
    const id = positiveId(decision.id, 'entry ID');
    if (seen.has(id))
      throw new ResumeImportDomainError(
        'Apply input contains duplicate entry IDs.',
      );
    seen.add(id);
    const proposal = proposalById.get(id);
    if (!proposal)
      throw new ResumeImportDomainError(
        'Apply entry was not in the server proposal.',
      );
    if (decision.action === 'skip') {
      result.skippedIds.push(id);
      continue;
    }
    const fields = validateResumeImportFields(proposal.kind, decision.fields);
    const skillEvidence =
      proposal.kind === 'skill'
        ? resolveSkillEvidence(
            proposal.fields.skillEvidence,
            proposalById,
            appliedExperiences,
          )
        : [];
    let parentExperienceId: string | undefined;
    if (proposal.kind === 'project' && proposal.fields.proposalExperienceId) {
      const parentProposal = proposalById.get(
        proposal.fields.proposalExperienceId,
      );
      const parentDecision = decisionById.get(
        proposal.fields.proposalExperienceId,
      );
      if (parentProposal?.kind !== 'experience' || !parentDecision)
        throw new ResumeImportDomainError(
          'Project parent proposal entry is invalid.',
        );
      if (parentDecision.action !== 'skip') {
        parentExperienceId = appliedExperienceIds.get(
          proposal.fields.proposalExperienceId,
        );
        if (!parentExperienceId)
          throw new ResumeImportDomainError(
            'Project parent experience was not applied.',
          );
      }
    }
    if (decision.action === 'create') {
      const createdId = await applyCreate(
        proposal.kind,
        fields,
        subject,
        options.db,
        parentExperienceId,
        skillEvidence,
      );
      result.createdIds.push(createdId);
      if (proposal.kind === 'experience') {
        appliedExperienceIds.set(id, createdId);
        appliedExperiences.set(
          id,
          await appliedExperience(createdId, subject, options.db),
        );
      }
      continue;
    }
    if (decision.action !== 'merge')
      throw new ResumeImportDomainError('Unknown apply action.');
    const targetId = positiveId(decision.targetId, 'merge target ID');
    const captured = proposal.candidateMatches?.find(
      (match) => match.id === targetId,
    );
    if (!captured)
      throw new ResumeImportDomainError(
        'Merge target was not captured by the server proposal.',
      );
    await lockMergeTarget(proposal.kind, targetId, subject, options.db);
    const current = (
      await currentMatches(proposal.kind, subject, options.db)
    ).find((match) => match.id === targetId);
    if (!current || current.fingerprint !== captured.fingerprint)
      throw new ResumeImportDomainError(
        'Merge target changed; refresh the proposal.',
      );
    const mergedId = await applyMerge(
      proposal.kind,
      targetId,
      fields,
      subject,
      options.db,
      parentExperienceId,
      skillEvidence,
    );
    result.mergedIds.push(mergedId);
    if (proposal.kind === 'experience') {
      appliedExperienceIds.set(id, mergedId);
      appliedExperiences.set(
        id,
        await appliedExperience(mergedId, subject, options.db),
      );
    }
  }
  return result;
}
