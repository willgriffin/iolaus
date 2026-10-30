import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PublicProfileSnapshotV1,
  publicProfileSnapshotSchema,
} from '$lib/public-profile-contract.js';
import { publicProfileApiResponse } from './public-profile-api.js';
import { createPublicProfileStore } from './public-profile-store.js';
import './smrt.js';

const SECRET_NOTES =
  'PRIVATE_NOTES_SENTINEL I am authorised to work in Canada.';
const SECRET_EMAIL = 'private-contact-sentinel@example.invalid';
const owner = { tenantId: 'tenant-a', userId: 'user-a' };
const snapshot: PublicProfileSnapshotV1 = {
  version: 1,
  name: 'Avery Example',
  title: '',
  summary: '',
  links: [],
  experience: [],
  education: [],
  other: [],
  skills: [],
};

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('./public-profile-service', () => ({
  getPublicProfile: mocks.resolve,
}));

describe('assistant notes stay server-side', () => {
  let directory: string;
  let database: DatabaseInterface;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'iolaus-assistant-notes-'));
    database = await getDatabase({
      cache: false,
      type: 'sqlite',
      url: join(directory, 'profiles.sqlite'),
    });
    const ddl = getDDLStrategy('sqlite');
    for (const tableName of [
      'public_profile_identities',
      'public_profile_revisions',
      'candidate_profiles',
    ]) {
      const definition = Object.values(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      ).find((item) => item.tableName === tableName);
      if (!definition) throw new Error(`Missing ${tableName} schema.`);
      for (const statement of [
        ddl.generateCreateTable(definition),
        ...ddl.generateIndexes(definition),
        ...ddl.generateTriggers(definition),
      ])
        await database.query(statement);
    }
  });
  afterEach(async () => {
    await database?.close?.();
    await rm(directory, { force: true, recursive: true });
    mocks.resolve.mockReset();
  });

  async function profileRow(
    id: string,
    tenantId: string,
    ownerUserId: string,
    notes = SECRET_NOTES,
    email = SECRET_EMAIL,
  ) {
    await database.query(
      `INSERT INTO candidate_profiles (id, slug, context, tenant_id, owner_user_id, assistant_notes, assistant_contact_email)
       VALUES (?, ?, '', ?, ?, ?, ?)`,
      [id, `slug-${id}`, tenantId, ownerUserId, notes, email],
    );
  }
  async function publish(handle: string, sourceProfileId: string) {
    const store = createPublicProfileStore(database as never);
    const identity = await store.reserve(owner, handle);
    const id = randomUUID();
    await store.prepare(owner, {
      id,
      baseRevision: 0,
      snapshot,
      pdfPath: `public-profiles/${identity.id}/${id}/resume.pdf`,
      pdfSha256: 'a'.repeat(64),
      pdfBytes: 10,
      sourceProfileId,
    });
    await store.publish(owner, { revisionId: id, expectedRevision: 0 });
    return store;
  }

  it('returns the notes only for a published handle, from the profile it was captured from', async () => {
    await profileRow('candidate-a', owner.tenantId, owner.userId);
    const store = createPublicProfileStore(database as never);
    expect(await store.resolveAssistantNotes('avery-notes')).toBeNull();
    await publish('avery-notes', 'candidate-a');
    expect(await store.resolveAssistantNotes('Avery-Notes')).toEqual({
      notes: SECRET_NOTES,
      contactEmail: SECRET_EMAIL,
    });
    expect(await store.resolveAssistantNotes('not a handle!')).toBeNull();
    await store.unpublish(owner, 1);
    expect(await store.resolveAssistantNotes('avery-notes')).toBeNull();
  });

  it('never reads a profile owned by another tenant or user', async () => {
    await profileRow('candidate-foreign', 'tenant-b', owner.userId);
    await profileRow('candidate-other-user', owner.tenantId, 'user-b');
    const store = await publish('avery-foreign', 'candidate-foreign');
    expect(await store.resolveAssistantNotes('avery-foreign')).toBeNull();
    const second = createPublicProfileStore(database as never);
    const other = { tenantId: owner.tenantId, userId: 'user-b' };
    const identity = await second.reserve(other, 'avery-other-user');
    const id = randomUUID();
    await second.prepare(other, {
      id,
      baseRevision: 0,
      snapshot,
      pdfPath: `public-profiles/${identity.id}/${id}/resume.pdf`,
      pdfSha256: 'b'.repeat(64),
      pdfBytes: 10,
      sourceProfileId: 'candidate-a-missing',
    });
    await second.publish(other, { revisionId: id, expectedRevision: 0 });
    expect(await second.resolveAssistantNotes('avery-other-user')).toBeNull();
  });

  it('keeps the notes out of the resolved public snapshot, API JSON and snapshot schema', async () => {
    await profileRow('candidate-a', owner.tenantId, owner.userId);
    const store = await publish('avery-public', 'candidate-a');
    const resolved = await store.resolvePublic('avery-public');
    expect(resolved).not.toBeNull();
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain('PRIVATE_NOTES_SENTINEL');
    expect(serialized).not.toContain(SECRET_EMAIL);
    expect(serialized.toLowerCase()).not.toContain('assistantnotes');

    mocks.resolve.mockResolvedValue({
      handle: resolved?.identity.handle,
      snapshot: resolved?.revision.snapshot,
      publishedAt: resolved?.revision.createdAt,
      revisionId: resolved?.revision.id,
    });
    const body = await (await publicProfileApiResponse('avery-public')).text();
    expect(body).toContain('Avery Example');
    expect(body).not.toContain('PRIVATE_NOTES_SENTINEL');
    expect(body).not.toContain(SECRET_EMAIL);

    // A snapshot carrying the fields is rejected, not passed through.
    expect(
      publicProfileSnapshotSchema.safeParse({
        ...snapshot,
        assistantNotes: SECRET_NOTES,
      }).success,
    ).toBe(false);
    expect(
      publicProfileSnapshotSchema.safeParse({
        ...snapshot,
        assistantContactEmail: SECRET_EMAIL,
      }).success,
    ).toBe(false);
  });
});
