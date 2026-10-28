import { error } from '@sveltejs/kit';
import { privateRecordWhere } from './private-workspace.js';
import { invalidatePublishedResumeCache } from './resume-data.js';
import { queuePublishedCanonicalRefresh } from './resume-source-refresh.js';
import { getCollection } from './smrt.js';
import {
  assertWorkspaceResourceWritable,
  isPrivateWorkspaceClass,
  workspaceRecordAllowed,
  workspaceResourcePayload,
  workspaceResourceWhere,
} from './workspace-resource-policy.js';
import { getCurrentWorkspaceSubject } from './workspace-subject.js';

/**
 * Owner-scoped generic CRUD for candidate-owned classes, shared by the
 * `/api/[resource]` routes and the generated MCP `<class>_<action>` tools.
 *
 * The admin pages reach the same records through `admin-data.ts`, which
 * applies `workspaceResourceWhere` / `workspaceRecordAllowed` /
 * `workspaceResourcePayload`; this module applies the identical predicates so
 * an agent sees and changes exactly what the owner's UI would. The caller
 * has already established the verified workspace subject (request hook or
 * `runAsOwner` + `withVerifiedWorkspaceSubject`); nothing here reads
 * ownership from arguments.
 */

export type ScopedRecord = Record<string, unknown>;

type ScopedCollection = {
  count: (options?: Record<string, unknown>) => Promise<number>;
  create: (payload: ScopedRecord) => Promise<ScopedRecord & Saveable>;
  get: (id: string) => Promise<(ScopedRecord & Saveable) | null>;
  list: (options?: Record<string, unknown>) => Promise<ScopedRecord[]>;
};

type Saveable = {
  delete?: () => Promise<unknown>;
  save?: () => Promise<unknown>;
};

export interface ScopedListOptions {
  /** Bounded to `SCOPED_LIST_MAX_LIMIT`; anything unparsable means 50. */
  limit?: unknown;
  offset?: unknown;
  /** `column ASC|DESC`; anything else falls back to the collection default. */
  orderBy?: unknown;
  /** Caller filter; the ownership tuple is merged over it and always wins. */
  where?: unknown;
}

export const SCOPED_LIST_MAX_LIMIT = 200;

/**
 * Résumé source classes whose admin writes invalidate the published-résumé
 * cache and queue the canonical PDF refresh (`admin-data.ts`
 * `queueResumeRefreshAfterSourceWrite`). Agent writes run the same hook.
 */
const resumeSourceClassNames = new Set([
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'Attachment',
  'CandidateProfile',
  'CandidateProfileLink',
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
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
]);

export function isScopedResourceClass(className: string): boolean {
  return isPrivateWorkspaceClass(className);
}

export function isResumeSourceClass(className: string): boolean {
  return resumeSourceClassNames.has(className);
}

/** The side effect every admin write to a résumé source record performs. */
export function afterResumeSourceWrite(className: string): void {
  if (!resumeSourceClassNames.has(className)) return;
  invalidatePublishedResumeCache();
  queuePublishedCanonicalRefresh();
}

function serialize(record: unknown): ScopedRecord {
  return JSON.parse(JSON.stringify(record)) as ScopedRecord;
}

function normalizeOrderBy(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*(?: (?:ASC|DESC))?$/u.test(trimmed)
    ? trimmed
    : undefined;
}

function callerWhere(value: unknown): ScopedRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as ScopedRecord;
}

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), SCOPED_LIST_MAX_LIMIT);
}

function boundedOffset(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Identity columns the framework owns. An explicit `slug` (or `context`) on a
 * new object makes SMRT adopt the existing row carrying that natural key, and
 * its collision guard checks the tenant, not the owner tuple, so a payload
 * naming another owner's slug could overwrite and reassign their row. An
 * explicit `id` would likewise target an existing row. Agents never supply
 * identity; the server derives it.
 */
const serverAssignedIdentityFields = ['id', 'slug', 'context'] as const;

function rejectServerAssignedIdentity(
  payload: ScopedRecord,
  allowId = false,
): void {
  const supplied = serverAssignedIdentityFields.filter(
    (key) => Object.hasOwn(payload, key) && !(allowId && key === 'id'),
  );
  if (supplied.length) {
    error(
      400,
      `Record identity is assigned by the server; remove ${supplied.join(', ')}.`,
    );
  }
}

/**
 * Default ownership columns for a new private record. In shared-hosted mode
 * `workspaceResourcePayload` forces them; in a private installation the UI
 * form supplies them, so an agent payload that omits them gets the verified
 * subject's tuple rather than failing the `required` field validation.
 */
function ownershipDefaults(className: string): ScopedRecord {
  if (className === 'CandidateProfile') return {};
  const subject = getCurrentWorkspaceSubject();
  if (!subject?.profileId) return {};
  return privateRecordWhere({ ...subject, profileId: subject.profileId });
}

async function scopedCollection(className: string): Promise<ScopedCollection> {
  return (await getCollection(className)) as unknown as ScopedCollection;
}

export async function listScopedRecords(
  className: string,
  options: ScopedListOptions = {},
): Promise<{
  items: ScopedRecord[];
  limit: number;
  offset: number;
  total: number;
}> {
  const ownership = workspaceResourceWhere(className);
  const where = { ...callerWhere(options.where), ...ownership };
  const limit = boundedLimit(options.limit, 50);
  const offset = boundedOffset(options.offset);
  const collection = await scopedCollection(className);
  const listOptions: Record<string, unknown> = { limit, offset, where };
  const orderBy = normalizeOrderBy(options.orderBy);
  if (orderBy) listOptions.orderBy = orderBy;
  const rows = (await collection.list(listOptions)).filter((row) =>
    workspaceRecordAllowed(className, row),
  );
  const total = await collection.count({ where });
  return { items: rows.map(serialize), limit, offset, total };
}

async function ownedRecord(
  className: string,
  id: string,
): Promise<(ScopedRecord & Saveable) | null> {
  const recordId = id.trim();
  if (!recordId) return null;
  // Evaluate the ownership predicate first: it fails closed (403/409) when
  // the request has no verified candidate workspace.
  workspaceResourceWhere(className);
  const record = await (await scopedCollection(className)).get(recordId);
  return record && workspaceRecordAllowed(className, record) ? record : null;
}

export async function getScopedRecord(
  className: string,
  id: string,
): Promise<ScopedRecord | null> {
  const record = await ownedRecord(className, id);
  return record ? serialize(record) : null;
}

export async function createScopedRecord(
  className: string,
  payload: ScopedRecord,
): Promise<ScopedRecord> {
  assertWorkspaceResourceWritable(className);
  rejectServerAssignedIdentity(payload);
  const scoped = workspaceResourcePayload(className, {
    ...ownershipDefaults(className),
    ...payload,
  });
  const record = await (await scopedCollection(className)).create(scoped);
  await record.save?.();
  afterResumeSourceWrite(className);
  return serialize(record);
}

export async function updateScopedRecord(
  className: string,
  id: string,
  payload: ScopedRecord,
): Promise<ScopedRecord> {
  assertWorkspaceResourceWritable(className);
  const record = await ownedRecord(className, id);
  if (!record) error(404, 'Item not found');
  rejectServerAssignedIdentity(payload, true);
  const scoped = workspaceResourcePayload(className, payload);
  if (Object.hasOwn(scoped, 'id') && String(scoped.id) !== String(record.id)) {
    error(403, 'Record ownership cannot be changed.');
  }
  Object.assign(record, scoped);
  await record.save?.();
  afterResumeSourceWrite(className);
  return serialize(record);
}

export async function deleteScopedRecord(
  className: string,
  id: string,
): Promise<void> {
  assertWorkspaceResourceWritable(className);
  const record = await ownedRecord(className, id);
  if (!record) error(404, 'Item not found');
  if (typeof record.delete !== 'function') {
    error(500, 'This record cannot be deleted.');
  }
  await record.delete();
  afterResumeSourceWrite(className);
}
