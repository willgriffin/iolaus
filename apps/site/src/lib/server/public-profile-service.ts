import { createHash, randomUUID } from 'node:crypto';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
  publicProfileSnapshotSchema,
  publicProfileVisibilitySchema,
} from '$lib/public-profile-contract.js';
import { isSharedHosted } from './app-config.js';
import { getDbConfig } from './db.js';
import { type OwnerPrincipalLocals, runAsOwner } from './owner-principal.js';
import {
  candidateProfileWhere,
  getPrivateRecord,
} from './private-workspace.js';
import {
  projectPublicProfileSnapshot,
  renderPublicProfilePdf,
} from './public-profile-render.js';
import { createPublicProfileStore } from './public-profile-store.js';
import { loadAdminResumeSource } from './resume-data.js';
import { getResumeFilesystem } from './resume-files.js';
import { getCollection } from './smrt.js';
import {
  resolveWorkspaceSubjectForProfile,
  type WorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

export function requirePublicProfilesEnabled() {
  if (
    !isSharedHosted() ||
    process.env.IOLAUS_PUBLIC_PROFILES_ENABLED !== 'true'
  )
    error(404, 'Not found');
}
async function store() {
  return createPublicProfileStore(await resolveDatabase(getDbConfig()));
}
async function authorized<T>(
  locals: OwnerPrincipalLocals,
  action: string,
  fn: (subject: WorkspaceSubject) => Promise<T>,
): Promise<T> {
  requirePublicProfilesEnabled();
  return await runAsOwner(
    locals,
    async (run) => {
      const operation = workspaceWorkflowOperation('public-profile.manage');
      await run.assertOperation(operation.collection, operation.action);
      return await fn(workspaceSubjectFromLocals(locals));
    },
    { action: `public-profile.${action}` },
  );
}
const prepareSchema = z
  .object({
    handle: z.string().min(1).max(64),
    profileId: z.string().min(1).max(128),
    visibility: publicProfileVisibilitySchema,
  })
  .strict();
const publishSchema = z
  .object({
    revisionId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
const unpublishSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();

export async function getPublicProfileManager(locals: OwnerPrincipalLocals) {
  return await authorized(locals, 'manager', async (subject) => {
    const collection = await getCollection('CandidateProfile');
    const records = await collection.list({
      where: { ...candidateProfileWhere(subject), active: true },
      limit: 100,
    });
    const profiles = records
      .map((record) => record as unknown as Record<string, unknown>)
      .filter(
        (record) =>
          record.tenantId === subject.tenantId &&
          record.ownerUserId === subject.userId &&
          record.active === true,
      )
      .map((record) => ({
        id: String(record.id),
        label: String(
          record.name || record.title || record.profileKey || 'Resume',
        ),
      }));
    const persistence = await store();
    const identity = await persistence.getOwner(subject);
    const revisions = identity ? await persistence.listRevisions(subject) : [];
    const pending = revisions.find(
      (revision) =>
        revision.status === 'prepared' &&
        revision.baseRevision === identity?.revision,
    );
    return {
      identity: identity
        ? {
            id: identity.id,
            handle: identity.handle,
            candidateProfileId: identity.candidateProfileId,
            status: identity.deletedAt
              ? ('deleted' as const)
              : identity.currentRevisionId
                ? ('published' as const)
                : identity.revision > 0
                  ? ('unpublished' as const)
                  : ('draft' as const),
            revision: identity.revision,
            currentRevisionId: identity.currentRevisionId,
          }
        : null,
      profiles,
      prepared: pending
        ? {
            id: pending.id,
            snapshot: pending.snapshot,
            baseRevision: pending.baseRevision,
          }
        : null,
      publicUrl: identity
        ? `/people/${encodeURIComponent(identity.handle)}`
        : null,
    };
  });
}

export async function preparePublicProfile(
  locals: OwnerPrincipalLocals,
  input: unknown,
) {
  requirePublicProfilesEnabled();
  const parsed = prepareSchema.parse(input);
  // Capture facts once, from an explicitly selected owned profile. No private
  // edit after this point can mutate the preview or its publication.
  const captured = await authorized(locals, 'capture', async (subject) => {
    const selected = await resolveWorkspaceSubjectForProfile(parsed.profileId);
    const source = await loadAdminResumeSource(undefined, selected);
    const profile = await getPrivateRecord(
      'CandidateProfile',
      selected.profileId,
      selected,
    );
    if (!source || !profile)
      error(400, 'Set up your resume before creating a public profile.');
    const identity = await (await store()).reserve(subject, parsed.handle);
    const recent = await (await store()).listRevisions(subject);
    if (
      recent.filter(
        (revision) =>
          Date.parse(revision.createdAt) > Date.now() - 48 * 60 * 60 * 1000,
      ).length >= 20
    )
      error(
        429,
        'You can prepare up to 20 public resume previews in 48 hours.',
      );
    const snapshot = publicProfileSnapshotSchema.parse(
      projectPublicProfileSnapshot({
        source,
        visibility: parsed.visibility,
        contacts: {
          email: String(profile.email || source.profile.email || ''),
          phone: String(profile.phone || ''),
          location: String(profile.location || ''),
        },
      }),
    );
    return { subject, selected, identity, snapshot };
  });
  const id = randomUUID();
  const path = `public-profiles/${captured.identity.id}/${id}/resume.pdf`;
  const filesystem = await getResumeFilesystem();
  let attemptedWrite = false;
  try {
    const body = await renderPublicProfilePdf(captured.snapshot);
    if (body.byteLength > 10 * 1024 * 1024)
      error(413, 'The resume PDF is too large.');
    // Re-enter native authorization after rendering and at the storage/DB fences.
    await authorized(locals, 'write-artifact', async (subject) => {
      if (
        subject.userId !== captured.subject.userId ||
        subject.tenantId !== captured.subject.tenantId
      )
        error(403, 'Workspace changed.');
      await resolveWorkspaceSubjectForProfile(parsed.profileId);
      attemptedWrite = true;
      await filesystem.write(path, Buffer.from(body), { createParents: true });
    });
    const revision = await authorized(locals, 'prepare', async (subject) => {
      await resolveWorkspaceSubjectForProfile(parsed.profileId);
      return await (await store()).prepare(subject, {
        id,
        baseRevision: captured.identity.revision,
        snapshot: captured.snapshot,
        pdfPath: path,
        pdfSha256: createHash('sha256').update(body).digest('hex'),
        pdfBytes: body.byteLength,
        sourceProfileId: captured.selected.profileId,
      });
    });
    return {
      id: revision.id,
      snapshot: revision.snapshot,
      baseRevision: revision.baseRevision,
      handle: captured.identity.handle,
    };
  } catch (cause) {
    if (attemptedWrite) {
      // An interrupted commit may already have stored the preview. Retain bytes
      // unless a successful read proves they are unreferenced; cleanup can
      // reconcile an unknown outcome later without breaking a saved revision.
      try {
        const saved = await (await store()).getPrepared(captured.subject, id);
        if (!saved) await filesystem.delete(path);
      } catch {
        /* Preserve an unknown outcome for the orphan reconciler. */
      }
    }
    throw cause;
  }
}

export async function publishPublicProfile(
  locals: OwnerPrincipalLocals,
  input: unknown,
) {
  const parsed = publishSchema.parse(input);
  return await authorized(locals, 'publish', async (subject) => {
    const persistence = await store();
    const revision = await persistence.getPrepared(subject, parsed.revisionId);
    if (!revision) error(404, 'Preview not found.');
    await resolveWorkspaceSubjectForProfile(revision.sourceProfileId);
    // Verify the exact reviewed artifact still exists before flipping visibility.
    await readPdf(revision);
    return await authorized(
      locals,
      'commit',
      async (freshSubject) =>
        await (await store()).publish(freshSubject, parsed),
    );
  });
}
export async function unpublishPublicProfile(
  locals: OwnerPrincipalLocals,
  input: unknown,
) {
  const parsed = unpublishSchema.parse(input);
  return await authorized(
    locals,
    'unpublish',
    async (subject) =>
      await (await store()).unpublish(subject, parsed.expectedRevision),
  );
}

export async function getPublicProfilePreview(
  locals: OwnerPrincipalLocals,
  id: string,
) {
  if (!z.string().uuid().safeParse(id).success) return null;
  return await authorized(locals, 'preview', async (subject) => {
    const persistence = await store();
    const revision = await persistence.getPrepared(subject, id);
    const identity = await persistence.getOwner(subject);
    return revision && identity
      ? {
          id: revision.id,
          snapshot: revision.snapshot,
          baseRevision: revision.baseRevision,
          handle: identity.handle,
        }
      : null;
  });
}
export async function getPublicProfilePreviewPdf(
  locals: OwnerPrincipalLocals,
  id: string,
) {
  if (!z.string().uuid().safeParse(id).success) return null;
  return await authorized(locals, 'preview-pdf', async (subject) => {
    const revision = await (await store()).getPrepared(subject, id);
    return revision ? await readPdf(revision) : null;
  });
}
async function readPdf(revision: {
  pdfPath: string;
  pdfSha256: string;
  pdfBytes: number;
}) {
  // Paths are constructed by this service and checked again at the read edge.
  if (
    !/^public-profiles\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/resume\.pdf$/.test(
      revision.pdfPath,
    ) ||
    revision.pdfBytes > 10 * 1024 * 1024
  )
    error(404, 'Resume unavailable.');
  const body = Buffer.from(
    (await (
      await getResumeFilesystem()
    ).read(revision.pdfPath, { raw: true })) as Uint8Array,
  );
  if (
    body.byteLength !== revision.pdfBytes ||
    createHash('sha256').update(body).digest('hex') !== revision.pdfSha256
  )
    error(404, 'Resume unavailable.');
  return { body: new Uint8Array(body), filename: 'resume.pdf' };
}
export async function getPublicProfile(handle: string) {
  requirePublicProfilesEnabled();
  const current = await (await store()).resolvePublic(handle);
  if (!current) return null;
  return {
    handle: current.identity.handle,
    snapshot: current.revision.snapshot,
    publishedAt: current.revision.createdAt,
    revisionId: current.revision.id,
  };
}
export async function getPublicProfilePdf(handle: string) {
  requirePublicProfilesEnabled();
  const persistence = await store();
  const current = await persistence.resolvePublic(handle);
  if (!current) return null;
  const pdf = await readPdf(current.revision);
  // Re-check after potentially slow storage access; withdrawn content is never
  // released just because the initial lookup preceded the withdrawal.
  const latest = await persistence.resolvePublic(handle);
  if (!latest || latest.revision.id !== current.revision.id) return null;
  return pdf;
}
