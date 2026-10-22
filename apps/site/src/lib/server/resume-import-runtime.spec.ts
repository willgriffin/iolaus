import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCandidateWorkspaceSubject } from './workspace-subject.js';

const state = vi.hoisted(() => ({
  active: vi.fn(),
  assets: vi.fn(async () => ({})),
  assertOperation: vi.fn(),
  progress: vi.fn(),
  host: { process: vi.fn(), repair: vi.fn() },
  hostFactory: vi.fn(),
  revalidate: vi.fn(),
  service: { expire: vi.fn() },
}));

vi.mock('@happyvertical/smrt-assets', () => ({
  createAssetRuntime: state.assets,
}));
vi.mock('@happyvertical/smrt-agents', () => ({ executeAsPrincipal: vi.fn() }));
vi.mock('@happyvertical/smrt-core', () => ({ resolveDatabase: vi.fn() }));
vi.mock('@happyvertical/smrt-users', () => ({
  getRequestScopedDatabase: vi.fn(),
}));
vi.mock('@happyvertical/smrt-ingestion/server', () => ({
  IngestionService: class {
    constructor() {
      Object.assign(this, state.service);
    }
  },
}));
vi.mock('./resume-import-extraction.js', () => ({
  extractResumeImport: vi.fn(),
}));
vi.mock('./resume-import-host.js', () => ({
  RESUME_IMPORT_JOB_TARGET: {
    objectType: 'ResumeImportJob',
    method: 'process',
  },
  createResumeImportHost: state.hostFactory,
}));
vi.mock('./db.js', () => ({ getDbConfig: vi.fn() }));
vi.mock('./runtime-paths.js', () => ({
  getIolausUserAssetsRoot: vi.fn(() => '/tmp/assets'),
}));
vi.mock('./resume-data.js', () => ({
  invalidatePublishedResumeCache: vi.fn(),
}));
vi.mock('./owner-principal.js', () => ({ ownerPrincipalOptions: vi.fn() }));
vi.mock('./workspace-subject.js', () => ({
  requireCandidateWorkspaceSubject: vi.fn(),
  withVerifiedWorkspaceSubject: vi.fn(),
  workspaceSubjectFromLocals: vi.fn(),
}));
vi.mock('./workspace-workflow-capabilities.js', () => ({
  workspaceWorkflowOperation: vi.fn(() => ({
    collection: 'workflow',
    action: 'profile.manage',
  })),
}));
vi.mock('./job-workspace-subject.js', () => ({
  requireActiveRunnerExecutionContext: state.active,
  runAsRevalidatedJobWorkspaceSubject: state.revalidate,
}));

import {
  exportResumeImportReceipts,
  getResumeImportHost,
  purgeExpiredResumeImportAssets,
  purgeResumeImportAccountData,
  RESUME_IMPORT_INGESTION_QUEUE,
  repairQueuedResumeImports,
  runResumeImportIngestionJob,
} from './resume-import-runtime.js';

const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const job = {
  objectType: 'ResumeImportJob',
  method: 'process',
  queue: RESUME_IMPORT_INGESTION_QUEUE,
  tenantId: 'tenant',
};
const args = { dispatchId: 'dispatch', itemId: 'item', revision: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMRT_RUNTIME_PROFILE', 'local');
  vi.stubEnv('IOLAUS_RESUME_IMPORT_STORAGE_JSON', undefined);
  state.hostFactory.mockReturnValue(state.host);
  state.active.mockReturnValue({ job, progress: state.progress });
  state.revalidate.mockImplementation(
    async (_subject, _operation, callback) =>
      await callback(subject, { assertOperation: state.assertOperation }),
  );
  state.host.process.mockResolvedValue({ id: 'item' });
  state.host.repair.mockResolvedValue(1);
  state.service.expire.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('resume import runtime', () => {
  it('uses one private provider configuration for request, worker, retention, recovery and account deletion', async () => {
    const storage = {
      type: 's3',
      bucket: 'private-ingestion',
      region: 'us-east-1',
    };
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'cloud');
    vi.stubEnv('IOLAUS_RESUME_IMPORT_STORAGE_JSON', JSON.stringify(storage));
    const row = {
      id: 'item',
      tenant_id: 'tenant',
      owner_user_id: 'user',
      confidential_scope_id: 'profile',
      data: { capturedCeiling: { execution: { principalId: 'user' } } },
    };
    const db = { query: vi.fn(async () => ({ rows: [row] })) } as any;
    vi.mocked(getRequestScopedDatabase).mockReturnValue(db);
    vi.mocked(requireCandidateWorkspaceSubject).mockReturnValue(subject as any);
    await getResumeImportHost({} as any);
    await runResumeImportIngestionJob(args, {} as any, db);
    await purgeExpiredResumeImportAssets(db);
    await repairQueuedResumeImports(db);
    await purgeResumeImportAccountData(db, subject);
    expect(state.assets).toHaveBeenCalledTimes(6);
    for (const [options] of state.assets.mock.calls as unknown as Array<
      [any]
    >) {
      expect(options).toEqual({
        db,
        storage,
        storeOptions: { resolver: expect.any(Function) },
      });
    }
    state.assets.mockClear();
    await exportResumeImportReceipts(db, subject);
    expect(state.assets).not.toHaveBeenCalled();
  });

  it('refuses hosted missing configuration before constructing an asset runtime', async () => {
    vi.stubEnv('SMRT_RUNTIME_PROFILE', 'cloud');
    const db = { query: vi.fn(async () => ({ rows: [] })) } as any;
    vi.mocked(getRequestScopedDatabase).mockReturnValue(db);
    vi.mocked(requireCandidateWorkspaceSubject).mockReturnValue(subject as any);
    await expect(getResumeImportHost({} as any)).rejects.toThrow(
      'Invalid private',
    );
    await expect(purgeResumeImportAccountData(db, subject)).rejects.toThrow(
      'Invalid private',
    );
    expect(state.assets).not.toHaveBeenCalled();
  });
  it('rejects direct or wrong-queue calls before reading private receipts', async () => {
    const db = { query: vi.fn() } as any;
    state.active.mockImplementation(() => {
      throw new Error('active runner required');
    });
    await expect(
      runResumeImportIngestionJob(args, undefined, db),
    ).rejects.toThrow('active runner required');
    expect(db.query).not.toHaveBeenCalled();

    state.active.mockReturnValue({ job: { ...job, queue: 'other' } });
    await expect(
      runResumeImportIngestionJob(args, {} as any, db),
    ).rejects.toThrow('authentic ingestion job');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('reconstructs the owner tuple from the durable receipt before processing', async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [
          {
            tenant_id: 'tenant',
            owner_user_id: 'user',
            confidential_scope_id: 'profile',
            data: { capturedCeiling: { execution: { principalId: 'user' } } },
          },
        ],
      })),
    } as any;
    await runResumeImportIngestionJob(args, {} as any, db);
    expect(state.revalidate).toHaveBeenCalledWith(
      subject,
      'profile.manage',
      expect.any(Function),
    );
    expect(state.assertOperation).toHaveBeenCalledWith(
      'resumeimports',
      'apply',
    );
    expect(state.host.process).toHaveBeenCalledWith(
      'item',
      1,
      expect.any(Function),
    );
    expect(state.progress).toHaveBeenCalledWith({
      stage: 'queued',
      progress: 0,
    });
  });

  it('exports metadata only and expires every owned receipt before account suspension', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'one',
              receipt_state: 'completed',
              processing_state: 'review',
              analysis_revision: 2,
              created_at: 'now',
              expires_at: null,
              visibility: 'private',
              data: { capturedCeiling: { execution: { principalId: 'user' } } },
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'one',
              confidential_scope_id: 'profile',
              data: { capturedCeiling: { execution: { principalId: 'user' } } },
            },
          ],
        }),
    } as any;
    await expect(exportResumeImportReceipts(db, subject)).resolves.toEqual([
      expect.objectContaining({ id: 'one', analysisRevision: 2 }),
    ]);
    await expect(purgeResumeImportAccountData(db, subject)).resolves.toBe(1);
    expect(state.service.expire).toHaveBeenCalledWith('one');
  });

  it('purges an expired revoked owner before skipping its unauthorized repair', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'expired',
              tenant_id: 'tenant',
              owner_user_id: 'revoked',
              confidential_scope_id: 'profile',
              data: {
                capturedCeiling: { execution: { principalId: 'revoked' } },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: 'tenant',
              owner_user_id: 'revoked',
              confidential_scope_id: 'profile',
              data: {
                capturedCeiling: { execution: { principalId: 'revoked' } },
              },
            },
          ],
        }),
    } as any;
    state.revalidate.mockRejectedValue(new Error('membership revoked'));
    await expect(repairQueuedResumeImports(db)).resolves.toBe(1);
    expect(state.service.expire).toHaveBeenCalledWith('expired');
    expect(state.revalidate).toHaveBeenCalledTimes(1);
  });

  it('continues expired retention and authorized repair after a malformed receipt', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'malformed',
              tenant_id: 'tenant',
              confidential_scope_id: 'profile',
              data: '{',
            },
            {
              id: 'expired',
              tenant_id: 'tenant',
              confidential_scope_id: 'profile',
              data: {
                capturedCeiling: { execution: { principalId: 'user' } },
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: 'tenant',
              owner_user_id: 'user',
              confidential_scope_id: 'profile',
            },
          ],
        }),
    } as any;

    await expect(repairQueuedResumeImports(db)).resolves.toBe(2);
    expect(state.service.expire).toHaveBeenCalledWith('expired');
    expect(state.host.repair).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      'Skipped expired resume import retention cleanup.',
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain('malformed');
  });

  it('repairs authorized scopes when the retention sweep itself fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      query: vi
        .fn()
        .mockRejectedValueOnce(new Error('retention database unavailable'))
        .mockResolvedValueOnce({
          rows: [
            {
              tenant_id: 'tenant',
              owner_user_id: 'user',
              confidential_scope_id: 'profile',
            },
          ],
        }),
    } as any;

    await expect(repairQueuedResumeImports(db)).resolves.toBe(1);
    expect(state.host.repair).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      'Skipped resume import retention cleanup during recovery.',
    );
  });
});
