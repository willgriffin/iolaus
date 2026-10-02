import type { SmrtObject } from '@happyvertical/smrt-core';
import { getCollection } from './smrt.js';
import type { WorkspaceSubject as VerifiedWorkspaceSubject } from './workspace-subject.js';

/**
 * Verified request authority for candidate-owned records. The auth boundary
 * creates this value; callers must never build it from form data or a tool
 * argument. `userId` is stored as `ownerUserId` to distinguish the acting
 * identity from reviewer/audit fields.
 */
export type WorkspaceSubject = VerifiedWorkspaceSubject & { profileId: string };

type PrivateRecord = Record<string, unknown>;
type PrivateCollection = {
  create: (payload: PrivateRecord) => Promise<PrivateRecord>;
  get: (id: string) => Promise<PrivateRecord | null>;
  list: (options?: Record<string, unknown>) => Promise<PrivateRecord[]>;
};

function requiredId(value: unknown, label: string): string {
  const id = typeof value === 'string' ? value.trim() : '';
  // IDs may be UUIDs or framework-provided stable keys. Validate their shape
  // enough to reject missing/control-character input without inventing a
  // UUID-only contract for test or external identity providers.
  if (
    !id ||
    id.length > 160 ||
    [...id].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new PrivateWorkspaceSubjectError(`Invalid ${label}.`);
  }
  return id;
}

export class PrivateWorkspaceSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivateWorkspaceSubjectError';
  }
}

/** Reject incomplete or untrusted-shaped ownership context before any read. */
export function requireWorkspaceSubject(
  value: WorkspaceSubject,
): WorkspaceSubject {
  return {
    profileId: requiredId(value?.profileId, 'candidate profile ID'),
    tenantId: requiredId(value?.tenantId, 'tenant ID'),
    userId: requiredId(value?.userId, 'user ID'),
  };
}

/** The only owner predicate used for private child collections. */
export function privateRecordWhere(subject: WorkspaceSubject): PrivateRecord {
  const verified = requireWorkspaceSubject(subject);
  return {
    candidateProfileId: verified.profileId,
    ownerUserId: verified.userId,
    tenantId: verified.tenantId,
  };
}

/** CandidateProfile has no self-reference but remains owned by tenant+user. */
export function candidateProfileWhere(
  subject: Omit<WorkspaceSubject, 'profileId'>,
): PrivateRecord {
  return {
    ownerUserId: requiredId(subject?.userId, 'user ID'),
    tenantId: requiredId(subject?.tenantId, 'tenant ID'),
  };
}

export function recordOwnedBySubject(
  record: PrivateRecord | null | undefined,
  subject: WorkspaceSubject,
): record is PrivateRecord {
  if (!record) return false;
  const where = privateRecordWhere(subject);
  return Object.entries(where).every(([key, value]) => record[key] === value);
}

/**
 * Fetch by opaque id and re-check all three ownership columns. TenantScoped
 * filters the tenant automatically; this closes the same-tenant multi-user
 * gap and protects code paths whose collection `get()` ignores a `where`.
 */
export async function getPrivateRecord(
  className: string,
  id: string,
  subject: WorkspaceSubject,
): Promise<PrivateRecord | null> {
  const recordId = requiredId(id, 'record ID');
  const collection = (await getCollection<SmrtObject>(
    className,
  )) as unknown as PrivateCollection;
  const record = await collection.get(recordId);
  return recordOwnedBySubject(record, subject) ? record : null;
}

/** Merge a caller filter with the non-overridable tenant/user/profile key. */
export async function listPrivateRecords(
  className: string,
  subject: WorkspaceSubject,
  options: Record<string, unknown> = {},
): Promise<PrivateRecord[]> {
  const collection = (await getCollection<SmrtObject>(
    className,
  )) as unknown as PrivateCollection;
  const callerWhere =
    options.where && typeof options.where === 'object'
      ? (options.where as PrivateRecord)
      : {};
  const rows = await collection.list({
    ...options,
    where: { ...callerWhere, ...privateRecordWhere(subject) },
  });
  // Defend against collection mocks/adapters that do not honour a compound
  // predicate. This is also useful evidence in cross-profile tests.
  return rows.filter((row) => recordOwnedBySubject(row, subject));
}

/** Create private rows with authority-derived ownership, never request input. */
export async function createPrivateRecord(
  className: string,
  subject: WorkspaceSubject,
  payload: PrivateRecord,
): Promise<PrivateRecord> {
  const ownership = privateRecordWhere(subject);
  for (const [key, value] of Object.entries(ownership)) {
    if (key in payload && payload[key] !== value) {
      throw new PrivateWorkspaceSubjectError(
        `Private record ${key} must match the authenticated subject.`,
      );
    }
  }
  const collection = (await getCollection<SmrtObject>(
    className,
  )) as unknown as PrivateCollection;
  return await collection.create({ ...payload, ...ownership });
}
