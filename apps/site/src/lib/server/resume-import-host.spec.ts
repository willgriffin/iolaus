vi.mock('./resume-import-write-admission.js', () => ({
  beginResumeImportWrite: vi.fn(),
  resolveResumeImportWrite: vi.fn(),
}));

import {
  beginResumeImportWrite,
  resolveResumeImportWrite,
} from './resume-import-write-admission.js';

vi.mock('./resume-import-account-fence.js', () => ({
  withResumeImportAccountFence: async (
    _db: unknown,
    _scope: unknown,
    action: () => Promise<unknown>,
  ) => await action(),
  assertResumeImportAccountNotDeleting: vi.fn(async () => {}),
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  options: undefined as any,
  domainApply: vi.fn(),
  matches: vi.fn(),
  validateProposal: vi.fn(),
  service: {
    getItem: vi.fn(),
    getEvidence: vi.fn(),
    readEvidence: vi.fn(),
    listReviews: vi.fn(),
    getCompletedAnalysis: vi.fn(),
    receive: vi.fn(),
    analyze: vi.fn(),
    claimAnalysis: vi.fn(),
    completeAnalysis: vi.fn(),
    failAnalysis: vi.fn(),
    createAction: vi.fn(),
    previewProposal: vi.fn(),
    submitDecision: vi.fn(),
    applyAction: vi.fn(),
    expire: vi.fn(),
    sweepRetention: vi.fn(),
    repairDispatches: vi.fn(),
  },
}));
vi.mock('@happyvertical/smrt-ingestion/server', () => ({
  IngestionService: class {
    constructor(options: unknown) {
      state.options = options;
      Object.assign(this, state.service);
    }
  },
}));
vi.mock('./resume-import-domain.js', () => ({
  ResumeImportDomainError: class extends Error {},
  applyResumeImportDomain: state.domainApply,
  captureResumeImportMatches: state.matches,
  validateResumeImportProposalEntries: state.validateProposal,
  validateResumeImportApply: vi.fn(),
}));

import { RESUME_IMPORT_MAX_ENTRIES } from '$lib/resume-import';
import { ResumeImportDomainError } from './resume-import-domain.js';
import {
  createResumeImportHost,
  parseResumeImportApplyInput,
} from './resume-import-host.js';

const subject = { tenantId: 'tenant', userId: 'user', profileId: 'profile' };
const entries = [
  {
    id: 'skill-1',
    kind: 'skill' as const,
    fields: { name: 'TypeScript' },
    candidateMatches: [
      {
        id: 'skill-old',
        label: 'TypeScript',
        summary: '',
        fingerprint: 'private-fingerprint',
      },
    ],
  },
];
function setup() {
  const authorize = vi.fn(async () => ({
    permissions: ['workflow.profile.manage', 'resumeimports.apply'],
  }));
  const extract = vi.fn(async () => ({
    entries,
    warnings: [],
    provider: 'fixture',
    model: 'fixture',
    version: '1',
  }));
  const db = {
    query: vi.fn(async () => ({ rows: [{ safe_error: 'unavailable' }] })),
  } as any;
  const host = createResumeImportHost({
    db,
    assets: {} as any,
    subject,
    authorize,
    extract,
    operationModel: 'test:ResumeImport',
  });
  return { host, authorize, extract, db };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(beginResumeImportWrite).mockResolvedValue('write-invocation');
  vi.mocked(resolveResumeImportWrite).mockResolvedValue();
  state.service.getItem.mockResolvedValue({
    id: 'import',
    analysisRevision: 1,
    processingState: 'completed',
    traceId: 'Original.pdf',
  });
  state.service.getEvidence.mockResolvedValue([
    { id: 'evidence', partId: 'Resume.pdf' },
  ]);
  state.service.listReviews.mockResolvedValue({ actions: [] });
  state.service.getCompletedAnalysis.mockResolvedValue({
    revision: 1,
    attemptId: 'attempt',
    result: { output: { entries, warnings: [] } },
  });
  state.service.receive.mockResolvedValue({
    kind: 'accepted',
    itemId: 'import',
  });
  state.matches.mockResolvedValue([]);
  state.domainApply.mockResolvedValue({
    createdIds: [],
    mergedIds: [],
    skippedIds: ['skill-1'],
  });
});
describe('resume ingestion application adapter', () => {
  it('admits before native receive and resolves only accepted settlement', async () => {
    const { host } = setup();
    state.service.receive.mockImplementationOnce(async () => {
      expect(beginResumeImportWrite).toHaveBeenCalledOnce();
      expect(resolveResumeImportWrite).not.toHaveBeenCalled();
      return { kind: 'accepted', itemId: 'import' };
    });
    await host.receive({
      bytes: Buffer.from('%PDF-example'),
      filename: 'one.pdf',
      requestId: 'one',
    });
    expect(resolveResumeImportWrite).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      'write-invocation',
    );
  });
  it.each([
    'retry',
    'unknown',
    'throw',
  ])('retains unresolved evidence for %s outcomes', async (kind) => {
    const { host } = setup();
    if (kind === 'throw')
      state.service.receive.mockRejectedValueOnce(
        new Error('provider outcome unknown'),
      );
    else
      state.service.receive.mockResolvedValueOnce({
        kind,
        category: 'unavailable',
      });
    await expect(
      host.receive({
        bytes: Buffer.from('%PDF-example'),
        filename: 'one.pdf',
        requestId: 'one',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(beginResumeImportWrite).toHaveBeenCalledOnce();
    expect(resolveResumeImportWrite).not.toHaveBeenCalled();
  });
  it.each([
    { kind: 'rejected', category: 'expired' },
    { kind: 'rejected', category: 'limit' },
    { kind: 'rejected', category: 'invalid' },
    { kind: 'rejected', category: 'conflict' },
    { kind: 'retry', category: 'busy' },
  ])('resolves provably prewrite refusal $kind/$category', async (receipt) => {
    const { host } = setup();
    state.service.receive.mockResolvedValueOnce(receipt);
    await expect(
      host.receive({
        bytes: Buffer.from('%PDF-example'),
        filename: 'one.pdf',
        requestId: 'one',
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(resolveResumeImportWrite).toHaveBeenCalledWith(
      expect.anything(),
      subject,
      'write-invocation',
    );
  });
  it('never calls native receive when durable admission fails', async () => {
    vi.mocked(beginResumeImportWrite).mockRejectedValueOnce(
      new Error('admission closed'),
    );
    await expect(
      setup().host.receive({
        bytes: Buffer.from('%PDF-example'),
        filename: 'one.pdf',
        requestId: 'one',
      }),
    ).rejects.toThrow('admission closed');
    expect(state.service.receive).not.toHaveBeenCalled();
  });
  it('projects public candidates without private revision fingerprints', async () => {
    const view = await setup().host.get('import');
    expect(view.filename).toBe('Original.pdf');
    expect(view.status).toBe('review');
    expect(JSON.stringify(view)).not.toContain('private-fingerprint');
  });
  it('deduplicates reuploaded identical bytes independently of filename and request ID within the owned profile', async () => {
    const { host } = setup();
    await host.receive({
      bytes: Buffer.from('%PDF-example'),
      filename: 'one.pdf',
      requestId: 'one',
    });
    await host.receive({
      bytes: Buffer.from('%PDF-example'),
      filename: 'two.pdf',
      requestId: 'two',
    });
    const [first, second] = state.service.receive.mock.calls.map(
      ([value]) => value,
    );
    expect(first.deliveryKey).toBe(second.deliveryKey);
    expect(first.sourceId).toBe('iolaus-resume-upload:profile');
    expect(first.parts[0].partId).toBe(second.parts[0].partId);
  });
  it('returns the durable processing view without extracting in the request', async () => {
    const { host, extract } = setup();
    state.service.getItem.mockResolvedValueOnce({
      id: 'import',
      analysisRevision: 1,
      processingState: 'processing',
      traceId: 'Resume.pdf',
    });
    await expect(
      host.receive({
        bytes: Buffer.from('%PDF-example'),
        filename: 'resume.pdf',
        requestId: 'nonblocking',
      }),
    ).resolves.toMatchObject({ status: 'processing' });
    expect(extract).not.toHaveBeenCalled();
    expect(state.service.claimAnalysis).not.toHaveBeenCalled();
    expect(state.service.repairDispatches).toHaveBeenCalledOnce();
  });
  it('repairs a newly queued retry immediately without processing it in the request', async () => {
    const { host, extract } = setup();
    state.service.getItem
      .mockResolvedValueOnce({
        id: 'import',
        analysisRevision: 2,
        processingState: 'failed',
        traceId: 'Resume.pdf',
      })
      .mockResolvedValueOnce({
        id: 'import',
        analysisRevision: 3,
        processingState: 'processing',
        traceId: 'Resume.pdf',
      });
    await expect(host.retry('import', 'retry-request')).resolves.toMatchObject({
      status: 'processing',
    });
    expect(state.service.analyze).toHaveBeenCalledWith(
      'import',
      { stage: 'resume-import', version: '1' },
      'retry:retry-request',
    );
    expect(state.service.repairDispatches).toHaveBeenCalledOnce();
    expect(extract).not.toHaveBeenCalled();
  });
  it('keeps deleted receipts revoked and requires explicit new generation identity', async () => {
    const { host } = setup();
    const input = {
      bytes: Buffer.from('%PDF-example'),
      filename: 'resume.pdf',
      requestId: 'new-generation',
    };
    state.service.receive.mockResolvedValueOnce({
      kind: 'rejected',
      category: 'expired',
    });
    await expect(host.receive(input)).rejects.toMatchObject({
      code: 'expired_import',
      status: 409,
    });
    state.service.receive.mockResolvedValue({
      kind: 'accepted',
      itemId: 'new-import',
    });
    await host.receive({ ...input, newImport: true });
    await host.receive({ ...input, newImport: true });
    const calls = state.service.receive.mock.calls;
    expect(calls[1][0].deliveryKey).toBe(
      `${calls[0][0].deliveryKey}:generation:new-generation`,
    );
    expect(calls[2][0].deliveryKey).toBe(calls[1][0].deliveryKey);
  });
  it('starts an explicitly requested fresh generation even when an earlier import is still applied', async () => {
    const { host } = setup();
    const input = {
      bytes: Buffer.from('%PDF-example'),
      filename: 'resume.pdf',
      requestId: 'fresh-after-applied',
    };
    await host.receive(input);
    await host.receive({ ...input, newImport: true });
    const calls = state.service.receive.mock.calls;
    expect(calls[1][0].deliveryKey).toBe(
      `${calls[0][0].deliveryKey}:generation:fresh-after-applied`,
    );
    expect(calls).toHaveLength(2);
  });
  it('passes the native transaction executor to both fresh authorization and domain writes', async () => {
    const { authorize } = setup();
    const transaction = {};
    const proposal = { revision: '1', entries };
    const input = {
      revision: '1',
      entries: [{ id: 'skill-1', action: 'skip', fields: {} }],
    };
    await state.options.execution.handlers[0].execution.apply(
      { proposal, input },
      { db: transaction },
    );
    expect(authorize).toHaveBeenCalledWith({
      db: transaction,
      operation: 'execute',
    });
    expect(state.domainApply).toHaveBeenCalledWith(
      expect.objectContaining({ db: transaction, subject, proposal, input }),
    );
  });
  it('blocks domain writes after authority revocation at the native transaction fence', async () => {
    const { authorize } = setup();
    authorize.mockRejectedValueOnce(new Error('revoked'));
    await expect(
      state.options.execution.handlers[0].execution.apply(
        {
          proposal: { revision: '1', entries },
          input: { revision: '1', entries: [] },
        },
        { db: {} },
      ),
    ).rejects.toThrow('revoked');
    expect(state.domainApply).not.toHaveBeenCalled();
  });
  it('resumes an already authorized identical decision without publishing a new proposal', async () => {
    const { host } = setup();
    const input = {
      revision: '1',
      entries: [{ id: 'skill-1', action: 'skip', fields: {} }],
    };
    const proposal = { revision: '1', entries };
    state.service.createAction.mockResolvedValue('action');
    state.service.listReviews.mockResolvedValue({
      actions: [
        {
          review: { actionId: 'action', state: 'authorized', revision: 1 },
          args: { proposal, input },
        },
      ],
    });
    state.service.applyAction.mockResolvedValue({ state: 'succeeded' });
    await host.apply('import', input);
    expect(state.service.previewProposal).not.toHaveBeenCalled();
    expect(state.service.submitDecision).not.toHaveBeenCalled();
    expect(state.service.applyAction).toHaveBeenCalledWith('action');
  });
  it('rejects stale review before allocating an execution action', async () => {
    const { host } = setup();
    await expect(
      host.apply('import', { revision: '2', entries: [] }),
    ).rejects.toThrow('proposal changed');
    expect(state.service.createAction).not.toHaveBeenCalled();
  });
  it('rejects malformed/oversized fields and repeated entry IDs', () => {
    expect(() =>
      parseResumeImportApplyInput({
        revision: '1',
        entries: [{ id: 'x', action: 'delete', fields: {} }],
      }),
    ).toThrow();
    expect(() =>
      parseResumeImportApplyInput({
        revision: '1',
        entries: [
          { id: 'x', action: 'skip', fields: {} },
          { id: 'x', action: 'skip', fields: {} },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseResumeImportApplyInput({
        revision: '1',
        entries: [
          { id: 'x', action: 'create', fields: { name: 'x'.repeat(20001) } },
        ],
      }),
    ).toThrow();
  });
  it('accepts a review decision at the shared 200-entry boundary and rejects 201', () => {
    const decisions = Array.from(
      { length: RESUME_IMPORT_MAX_ENTRIES },
      (_, index) => ({
        id: `entry-${index}`,
        action: 'skip' as const,
        fields: {},
      }),
    );
    expect(
      parseResumeImportApplyInput({ revision: '1', entries: decisions })
        .entries,
    ).toHaveLength(RESUME_IMPORT_MAX_ENTRIES);
    expect(() =>
      parseResumeImportApplyInput({
        revision: '1',
        entries: [
          ...decisions,
          { id: 'entry-over', action: 'skip', fields: {} },
        ],
      }),
    ).toThrow(/at most 200 entries/u);
  });
  it('returns a durable failed state without storing raw provider errors', async () => {
    const { host, extract } = setup();
    state.service.getItem
      .mockResolvedValueOnce({ analysisRevision: 1, processingState: 'queued' })
      .mockResolvedValue({
        analysisRevision: 1,
        processingState: 'needs_attention',
      });
    state.service.claimAnalysis.mockResolvedValue({
      itemId: 'import',
      revision: 1,
    });
    state.service.readEvidence.mockResolvedValue(Buffer.from('%PDF-'));
    extract.mockRejectedValue(new Error('secret-provider-content'));
    const result = await host.process('import');
    expect(result.status).toBe('failed');
    expect(state.service.failAnalysis).toHaveBeenCalledWith(
      { itemId: 'import', revision: 1 },
      'unavailable',
    );
    expect(JSON.stringify(result)).not.toContain('secret-provider-content');
  });
  it('accepts proposals through the shared 200-entry boundary', async () => {
    const { host, extract } = setup();
    extract.mockResolvedValue({
      entries: Array.from(
        { length: RESUME_IMPORT_MAX_ENTRIES },
        (_, index) => ({
          id: `skill-${index}`,
          kind: 'skill',
          fields: { name: `Skill ${index}` },
        }),
      ),
      warnings: [],
      provider: 'fixture',
      model: 'fixture',
      version: '1',
    } as any);
    state.service.getItem
      .mockResolvedValueOnce({ analysisRevision: 1, processingState: 'queued' })
      .mockResolvedValue({ analysisRevision: 1, processingState: 'completed' });
    state.service.claimAnalysis.mockResolvedValue({
      itemId: 'import',
      revision: 1,
    });
    await host.process('import');
    expect(state.service.completeAnalysis).toHaveBeenCalledOnce();
    expect(state.service.failAnalysis).not.toHaveBeenCalled();
  });
  it('logs only bounded counts and treats a 201-entry proposal as malformed output', async () => {
    const { host, extract } = setup();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    extract.mockResolvedValue({
      entries: Array.from(
        { length: RESUME_IMPORT_MAX_ENTRIES + 1 },
        (_, index) => ({
          id: `skill-${index}`,
          kind: 'skill',
          fields: { name: `private-${index}` },
        }),
      ),
      warnings: [],
      provider: 'fixture',
      model: 'fixture',
      version: '1',
    } as any);
    state.service.getItem
      .mockResolvedValueOnce({ analysisRevision: 1, processingState: 'queued' })
      .mockResolvedValue({
        analysisRevision: 1,
        processingState: 'needs_attention',
      });
    state.service.claimAnalysis.mockResolvedValue({
      itemId: 'import',
      revision: 1,
    });
    await host.process('import');
    expect(log).toHaveBeenCalledWith('Resume import proposal rejected.', {
      reason: 'host_entry_limit',
      entryCount: RESUME_IMPORT_MAX_ENTRIES + 1,
      kindCounts: { skill: RESUME_IMPORT_MAX_ENTRIES + 1 },
    });
    expect(state.service.failAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      'malformed_output',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-0');
  });
  it('accepts a representative 125-entry proposal', async () => {
    const { host, extract } = setup();
    extract.mockResolvedValue({
      entries: Array.from({ length: 125 }, (_, index) => ({
        id: `skill-${index}`,
        kind: 'skill',
        fields: { name: `Skill ${index}` },
      })),
      warnings: [],
      provider: 'fixture',
      model: 'fixture',
      version: '1',
    } as any);
    state.service.getItem
      .mockResolvedValueOnce({ analysisRevision: 1, processingState: 'queued' })
      .mockResolvedValue({ analysisRevision: 1, processingState: 'completed' });
    state.service.claimAnalysis.mockResolvedValue({
      itemId: 'import',
      revision: 1,
    });
    await host.process('import');
    expect(state.service.completeAnalysis).toHaveBeenCalledOnce();
    expect(state.service.failAnalysis).not.toHaveBeenCalled();
  });
  it('maps a domain validation failure to malformed output without logging its message', async () => {
    const { host } = setup();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.validateProposal.mockImplementationOnce(() => {
      throw new ResumeImportDomainError('Invalid calendar date.');
    });
    state.service.getItem
      .mockResolvedValueOnce({ analysisRevision: 1, processingState: 'queued' })
      .mockResolvedValue({
        analysisRevision: 1,
        processingState: 'needs_attention',
      });
    state.service.claimAnalysis.mockResolvedValue({
      itemId: 'import',
      revision: 1,
    });
    await host.process('import');
    expect(state.service.failAnalysis).toHaveBeenCalledWith(
      expect.anything(),
      'malformed_output',
    );
    expect(log).toHaveBeenCalledWith('Resume import proposal rejected.', {
      reason: 'invalid_calendar_date',
    });
  });
});
