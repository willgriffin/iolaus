import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileNotFoundError,
  type FilesystemInterface,
} from '@happyvertical/files';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import '@happyvertical/smrt-ingestion/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insert } from './fixtures/account-seed.js';
import {
  purgeQuarantinedResumeOriginals,
  recoverQuarantinedResumeOriginal,
  resolveQuarantinedResumeStorage,
} from './resume-import-quarantine.js';
import './smrt.js';

type Db = Awaited<ReturnType<typeof getTestDatabase>>;
const classes = [
  'ResumeImportQuarantine',
  'ResumeImportRecoveryAudit',
  'ResumeImportWriteOperation',
  'IntakeItem',
  'IntakeEvidence',
  'IntakeDeletion',
];
const storage = {
  type: 's3' as const,
  bucket: 'private-originals',
  region: 'garage',
  endpoint: 'http://garage.garage.svc.cluster.local:3900',
  forcePathStyle: true,
};
const identity = 's3://private-originals/';
const before = new Date('2026-11-03T23:59:59Z'),
  due = new Date('2026-11-04T00:00:00Z');
const bytes = Buffer.from('%PDF-fictional original');
function contract(create: () => Promise<Db>) {
  async function setup() {
    const db = await create();
    const tenantId = randomUUID(),
      userId = randomUUID(),
      profileId = randomUUID(),
      assetId = randomUUID(),
      itemId = randomUUID();
    const key = `intake/${assetId}.pdf`;
    await insert(db, 'intake_items', {
      id: itemId,
      tenant_id: tenantId,
      confidential_scope_id: profileId,
      visibility: 'expired',
      expires_at: '2026-10-30T00:00:00.000Z',
      data: JSON.stringify({
        capturedCeiling: { execution: { principalId: userId } },
      }),
    });
    await insert(db, 'intake_evidence', {
      item_id: itemId,
      tenant_id: tenantId,
      confidential_scope_id: profileId,
      asset_id: assetId,
      source_uri: identity + key,
      parent_evidence_id: null,
      part_id: 'Resume.pdf',
      media_type: 'application/pdf',
      content_hash: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.length,
      state: 'revoked',
    });
    await insert(db, 'intake_deletions', {
      item_id: itemId,
      tenant_id: tenantId,
      confidential_scope_id: profileId,
      created_at: '2026-10-05T00:00:00.000Z',
    });
    let retained: Buffer | undefined = bytes;
    const filesystem = {
      read: vi.fn(async () => {
        if (!retained) throw new Error('missing');
        return retained;
      }),
      write: vi.fn(async () => {}),
      delete: vi.fn(async () => {
        retained = undefined;
      }),
    } as unknown as FilesystemInterface;
    const request = {
      operation: 'delete' as const,
      asset: { id: assetId, tenantId, name: 'CV-final-2026 (reviewed).pdf' },
      sourceUri: identity + key,
      path: key,
      defaultFilesystem: filesystem,
      defaultProviderOptions: storage,
    } as any;
    const quarantine = async () =>
      await resolveQuarantinedResumeStorage(db, identity, key, request);
    const row = async () =>
      (await db.query('SELECT * FROM resume_import_quarantines'))
        .rows[0] as Record<string, unknown>;
    const authority = {
      tenantId,
      actorId: 'operator:fictional',
      destinationAuthority: 'verified-owner-export',
      reason: 'explicit recovery request',
    };
    const recover = async (changes: Record<string, unknown> = {}) =>
      await recoverQuarantinedResumeOriginal({
        db,
        storage,
        quarantineId: String((await row()).id),
        authority,
        authorize: async () => true,
        filesystem,
        now: before,
        ...changes,
      });
    return {
      db,
      tenantId,
      userId,
      profileId,
      assetId,
      itemId,
      key,
      filesystem,
      request,
      quarantine,
      row,
      recover,
      authority,
      setBytes: (value: Buffer) => {
        retained = value;
      },
    };
  }
  it('captures before redaction, survives metadata loss/restart replay, and fixes first deadline', async () => {
    const s = await setup();
    const target = await s.quarantine();
    await target?.filesystem?.delete(s.key);
    expect(s.filesystem.delete).not.toHaveBeenCalled();
    const row = await s.row();
    expect(new Date(String(row.purge_after)).toISOString()).toBe(
      due.toISOString(),
    );
    expect(row).toMatchObject({
      tenant_id: s.tenantId,
      user_id: s.userId,
      profile_id: s.profileId,
      asset_id: s.assetId,
      item_id: s.itemId,
    });
    await s.db.query('DELETE FROM intake_evidence');
    await s.db.query('DELETE FROM intake_deletions');
    await s.db.query('DELETE FROM intake_items');
    await s.quarantine();
    expect(await s.row()).toEqual(row);
    expect(await s.recover()).toEqual(bytes);
    expect(
      (await s.db.query('SELECT outcome FROM resume_import_recovery_audits'))
        .rows,
    ).toEqual([{ outcome: 'verified' }]);
  });
  it('denies revoked reads/writes before callback and quarantined/foreign reads/writes afterwards', async () => {
    const s = await setup();
    for (const operation of ['read', 'write'])
      await expect(
        resolveQuarantinedResumeStorage(s.db, identity, s.key, {
          ...s.request,
          operation,
        }),
      ).rejects.toThrow('unavailable');
    await s.quarantine();
    for (const operation of ['read', 'write'])
      await expect(
        resolveQuarantinedResumeStorage(s.db, identity, s.key, {
          ...s.request,
          operation,
        }),
      ).rejects.toThrow('unavailable');
    await expect(
      resolveQuarantinedResumeStorage(s.db, identity, s.key, {
        ...s.request,
        asset: { ...s.request.asset, tenantId: randomUUID() },
      }),
    ).rejects.toThrow('unavailable');
  });
  it('allows active I/O and checks again when a planned write starts after revocation', async () => {
    const s = await setup();
    await s.db.query("UPDATE intake_items SET visibility='active'");
    await s.db.query("UPDATE intake_evidence SET state='stored'");
    const target = await resolveQuarantinedResumeStorage(
      s.db,
      identity,
      s.key,
      { ...s.request, operation: 'write' },
    );
    expect(await target?.filesystem?.read(s.key)).toEqual(bytes);
    await s.db.query("UPDATE intake_items SET visibility='expired'");
    await expect(target?.filesystem?.write(s.key, bytes)).rejects.toThrow(
      'unavailable',
    );
    expect(s.filesystem.write).not.toHaveBeenCalled();
  });
  it('leaves derived PDFs on immediate deletion and fails closed for missing original provenance', async () => {
    const s = await setup();
    await s.db.query(
      "UPDATE intake_evidence SET part_id='derived.pdf',parent_evidence_id=(SELECT id FROM intake_evidence LIMIT 1)",
    );
    expect(await s.quarantine()).toBeUndefined();
    expect(await s.row()).toBeUndefined();
    await s.db.query('DELETE FROM intake_evidence');
    await expect(s.quarantine()).rejects.toThrow('unavailable');
  });
  it('purges at exact boundary, keeps tombstones and retries provider failures', async () => {
    const s = await setup();
    await s.quarantine();
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: before,
      }),
    ).toEqual({ purged: 0, pendingWrites: 0, failed: 0 });
    vi.mocked(s.filesystem.delete).mockRejectedValueOnce(
      new Error('provider unavailable'),
    );
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 0, pendingWrites: 0, failed: 1 });
    expect((await s.row()).purged_at).toBeNull();
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 1, pendingWrites: 0, failed: 0 });
    const row = await s.row();
    await s.quarantine();
    expect(await s.row()).toEqual(row);
    await expect(s.recover()).rejects.toThrow('unavailable');
  });
  it('never clears uncertain markers or claims finality while a late write can land', async () => {
    const s = await setup();
    await s.quarantine();
    await insert(s.db, 'resume_import_write_operations', {
      tenant_id: s.tenantId,
      user_id: s.userId,
    });
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 0, pendingWrites: 1, failed: 0 });
    expect((await s.row()).purged_at).toBeNull();
    s.setBytes(bytes); // Model an already-started provider PUT completing after DELETE.
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 0, pendingWrites: 1, failed: 0 });
    expect(
      (await s.db.query('SELECT id FROM resume_import_write_operations')).rows,
    ).toHaveLength(1);
    await s.db.query('DELETE FROM resume_import_write_operations'); // Test models explicit operator settlement; production never times out markers.
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 1, pendingWrites: 0, failed: 0 });
  });
  it('requires actor/tenant/destination authority and correct checksum for operator recovery', async () => {
    const s = await setup();
    await s.quarantine();
    for (const changes of [
      { authority: { ...s.authority, tenantId: randomUUID() } },
      { authorize: async () => false },
      { authority: { ...s.authority, destinationAuthority: '' } },
      { now: due },
    ])
      await expect(s.recover(changes)).rejects.toThrow('unavailable');
    expect(s.filesystem.read).not.toHaveBeenCalled();
    s.setBytes(Buffer.from('tampered'));
    await expect(s.recover()).rejects.toThrow('unavailable');
    expect(
      (await s.db.query('SELECT outcome FROM resume_import_recovery_audits'))
        .rows,
    ).toEqual([{ outcome: 'failed' }]);
    s.setBytes(bytes);
    expect(await s.recover()).toEqual(bytes);
  });
  it('treats an already-missing object as idempotently physically purged', async () => {
    const s = await setup();
    await s.quarantine();
    vi.mocked(s.filesystem.delete).mockRejectedValueOnce(
      new FileNotFoundError(s.key),
    );
    expect(
      await purgeQuarantinedResumeOriginals(s.db, storage, {
        filesystem: s.filesystem,
        now: due,
      }),
    ).toEqual({ purged: 1, pendingWrites: 0, failed: 0 });
    expect((await s.row()).purged_at).toBeTruthy();
  });
  it('never reads recovery bytes when its required audit cannot be persisted', async () => {
    const s = await setup();
    await s.quarantine();
    const db = {
      query: async (sql: string, ...parameters: unknown[]) => {
        if (sql.includes('INSERT INTO resume_import_recovery_audits'))
          throw new Error('audit unavailable');
        return await (s.db.query as (...args: unknown[]) => Promise<unknown>)(
          sql,
          ...parameters,
        );
      },
    };
    await expect(s.recover({ db })).rejects.toThrow('audit unavailable');
    expect(s.filesystem.read).not.toHaveBeenCalled();
  });
  it('rolls ledger insertion back on its native transaction executor', async () => {
    const s = await setup();
    if (!s.db.transaction) throw new Error('Native transactions required.');
    await expect(
      s.db.transaction(async (tx) => {
        await resolveQuarantinedResumeStorage(tx, identity, s.key, s.request);
        throw new Error('abort test transaction');
      }),
    ).rejects.toThrow('abort test transaction');
    expect(await s.row()).toBeUndefined();
    await s.quarantine();
    expect(await s.row()).toBeDefined();
  });
  it('does not extend upload expiry when the native sweep is delayed', async () => {
    const s = await setup();
    await s.db.query('UPDATE intake_deletions SET created_at=?', [
      '2026-11-03T00:00:00.000Z',
    ]);
    await s.quarantine();
    expect(new Date(String((await s.row()).purge_after)).toISOString()).toBe(
      '2026-11-29T00:00:00.000Z',
    );
  });
  it('starts a separate 30 day recovery window at upload expiry', async () => {
    const s = await setup();
    await s.db.query('UPDATE intake_deletions SET created_at=?', [
      '2026-10-30T00:00:00.000Z',
    ]);
    await s.quarantine();
    expect(new Date(String((await s.row()).purge_after)).toISOString()).toBe(
      '2026-11-29T00:00:00.000Z',
    );
  });
}
describe('original quarantine native SQLite', () => {
  const resources: { db: Db; path: string }[] = [];
  afterEach(async () => {
    for (const { db, path } of resources.splice(0)) {
      await db.close?.();
      await rm(path, { force: true });
    }
  });
  contract(async () => {
    const path = join(tmpdir(), `iolaus-quarantine-${randomUUID()}.sqlite`);
    const db = await getTestDatabase({ classes, url: path });
    resources.push({ db, path });
    return db;
  });
});
const postgresUrl =
  process.env.RESUME_QUARANTINE_POSTGRES_TEST_DATABASE_URL?.trim();
describe.runIf(postgresUrl)('original quarantine native PostgreSQL', () => {
  const resources: { db: Db; schema: string }[] = [];
  afterEach(async () => {
    for (const { db, schema } of resources.splice(0)) {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close?.();
    }
  });
  contract(async () => {
    if (!postgresUrl) throw new Error('Expected isolated PostgreSQL URL.');
    const url = new URL(postgresUrl);
    if (url.pathname !== '/iolaus_resume_import_qa')
      throw new Error('Use isolated iolaus_resume_import_qa database.');
    const schema = `quarantine_${randomUUID().replaceAll('-', '')}`;
    url.searchParams.set('options', `-c search_path=${schema}`);
    const db = await getDatabase({
      cache: false,
      type: 'postgres',
      url: url.toString(),
      max: 5,
    });
    await db.query(`CREATE SCHEMA "${schema}"`);
    resources.push({ db, schema });
    return await getTestDatabase({ db, classes });
  });
});
