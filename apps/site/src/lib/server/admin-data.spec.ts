import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AdminResource, getAdminResource } from '$lib/admin/resources';
import {
  assertAdminWorkflowPayload,
  countAdminResourceRecords,
  createAdminRecord,
  deleteAdminRecord,
  getAdminRecord,
  listAdminRecords,
  listComboOptions,
  listReferenceOptions,
  parseResourceForm,
  updateAdminRecord,
} from './admin-data';

type MockSmrtRecord = Record<string, unknown> & {
  id: string;
  save: () => Promise<void>;
};

type MockListOptions = {
  limit?: number;
  offset?: number;
  where?: Record<string, unknown>;
};

function matchesWhere(
  record: MockSmrtRecord,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => record[key] === value);
}

function mockCollection(initialRecords: Array<Record<string, unknown>> = []) {
  const records: MockSmrtRecord[] = initialRecords.map((record, index) => ({
    ...record,
    id: String(record.id ?? index + 1),
    save: vi.fn(async () => {}),
  }));
  const collection = {
    created: [] as MockSmrtRecord[],
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const record = {
        id: `${records.length + collection.created.length + 1}`,
        ...payload,
        save: vi.fn(async () => {}),
      } as MockSmrtRecord;
      collection.created.push(record);
      records.push(record);
      return record;
    }),
    delete: vi.fn(async (id: string) => {
      const index = records.findIndex((record) => record.id === id);
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    }),
    get: vi.fn(
      async (id: string) => records.find((record) => record.id === id) ?? null,
    ),
    list: vi.fn(async (options: MockListOptions = {}) => {
      const filtered = records.filter((record) =>
        matchesWhere(record, options.where),
      );
      const offset = options.offset ?? 0;
      return filtered.slice(
        offset,
        options.limit === undefined ? undefined : offset + options.limit,
      );
    }),
    count: vi.fn(async (options: Pick<MockListOptions, 'where'> = {}) => {
      return records.filter((record) => matchesWhere(record, options.where))
        .length;
    }),
  };
  return collection;
}

const smrtMock = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof mockCollection>>(),
}));
const scheduleMock = vi.hoisted(() => ({
  deleteSourceSchedule: vi.fn(async () => undefined),
  syncSourceSchedule: vi.fn(async () => null),
}));
const workflowMock = vi.hoisted(() => ({
  normalizeAccountStatus: vi.fn((value: unknown) => {
    const status = typeof value === 'string' ? value.trim() : '';
    if (status === 'needs_magic') {
      const error = new Error('Invalid account status.') as Error & {
        body?: { message: string };
        status?: number;
      };
      error.body = { message: 'Invalid account status.' };
      error.status = 400;
      throw error;
    }
    return status || 'unknown';
  }),
  syncApplicationWorkflowTasks: vi.fn(async () => ({ created: 0 })),
  syncRecommendedOpportunityDecisionTasks: vi.fn(async () => ({
    closed: 0,
    created: 0,
    existing: 0,
    scanned: 0,
  })),
  syncSourceAccountTasks: vi.fn(async () => ({ created: 0, existing: 0 })),
  validateSubmittedApplicationPayload: vi.fn(() => null as string | null),
}));
const resumeVariantWorkflowMock = vi.hoisted(() => ({
  resumeVariantDeleteViolation: vi.fn(async () => ''),
  releaseResumeVariantApplicationWrite: vi.fn(async () => ({
    applicationLocksReleased: true,
    workflowTasksSynced: true,
  })),
  reserveResumeVariantApplicationWrite: vi.fn(async () => ({
    reservation: null,
    violation: '',
  })),
  resumeVariantWriteViolation: vi.fn(async () => ''),
  syncResumeVariantApplicationApprovals: vi.fn(async () => ({
    invalidated: 0,
    selected: 0,
  })),
}));
const resumeRefreshMock = vi.hoisted(() => ({
  invalidatePublishedResumeCache: vi.fn(),
  queuePublishedCanonicalRefresh: vi.fn(() => ({
    debounceMs: 1500,
    queued: true,
  })),
}));
const applicationConcurrencyMock = vi.hoisted(() => ({
  applicationUpdatesFromPayload: vi.fn(
    (payload: Record<string, unknown>) => payload,
  ),
  commitApplicationIfCurrent: vi.fn(
    async (
      application: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => {
      Object.assign(application, updates);
      return true;
    },
  ),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const collection = smrtMock.collections.get(className);
    if (!collection)
      throw new Error(`Missing mock collection for ${className}`);
    return collection;
  }),
}));

vi.mock('./source-schedules.js', () => ({
  deleteSourceSchedule: scheduleMock.deleteSourceSchedule,
  syncSourceSchedule: scheduleMock.syncSourceSchedule,
}));

vi.mock('./application-workflow.js', () => ({
  normalizeAccountStatus: workflowMock.normalizeAccountStatus,
  syncApplicationWorkflowTasks: workflowMock.syncApplicationWorkflowTasks,
  syncRecommendedOpportunityDecisionTasks:
    workflowMock.syncRecommendedOpportunityDecisionTasks,
  syncSourceAccountTasks: workflowMock.syncSourceAccountTasks,
  validateSubmittedApplicationPayload:
    workflowMock.validateSubmittedApplicationPayload,
}));

vi.mock('./application-concurrency.js', () => ({
  applicationUpdatesFromPayload:
    applicationConcurrencyMock.applicationUpdatesFromPayload,
  commitApplicationIfCurrent:
    applicationConcurrencyMock.commitApplicationIfCurrent,
}));

vi.mock('./resume-variant-workflow.js', () => ({
  releaseResumeVariantApplicationWrite:
    resumeVariantWorkflowMock.releaseResumeVariantApplicationWrite,
  reserveResumeVariantApplicationWrite:
    resumeVariantWorkflowMock.reserveResumeVariantApplicationWrite,
  resumeVariantDeleteViolation:
    resumeVariantWorkflowMock.resumeVariantDeleteViolation,
  resumeVariantWriteViolation:
    resumeVariantWorkflowMock.resumeVariantWriteViolation,
  syncResumeVariantApplicationApprovals:
    resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals,
}));

vi.mock('./resume-data.js', () => ({
  invalidatePublishedResumeCache:
    resumeRefreshMock.invalidatePublishedResumeCache,
}));

vi.mock('./resume-source-refresh.js', () => ({
  queuePublishedCanonicalRefresh:
    resumeRefreshMock.queuePublishedCanonicalRefresh,
}));

beforeEach(() => {
  applicationConcurrencyMock.applicationUpdatesFromPayload.mockClear();
  applicationConcurrencyMock.commitApplicationIfCurrent.mockReset();
  applicationConcurrencyMock.commitApplicationIfCurrent.mockImplementation(
    async (application, updates) => {
      Object.assign(application, updates);
      return true;
    },
  );
  resumeRefreshMock.invalidatePublishedResumeCache.mockClear();
  resumeRefreshMock.queuePublishedCanonicalRefresh.mockClear();
});

const resource: AdminResource = {
  className: 'Opportunity',
  description: '',
  fields: [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'requiredSkills', label: 'Required skills', kind: 'textarea' },
    { key: 'salaryMin', label: 'Salary min', kind: 'number' },
    { key: 'greenfieldSignal', label: 'Greenfield', kind: 'checkbox' },
    { key: 'postedAt', label: 'Posted', kind: 'datetime' },
    { key: 'startDate', label: 'Start date', kind: 'date' },
    {
      key: 'humanRating',
      label: 'Rating',
      kind: 'select',
      options: ['', '1', '2', '3', '4', '5'],
      coerce: 'number',
    },
  ],
  icon: 'briefcase',
  label: 'Opportunities',
  orderBy: 'updated_at DESC',
  singularLabel: 'Opportunity',
  slug: 'opportunities',
  tableColumns: ['title'],
};

const resumeVariantResource: AdminResource = {
  className: 'ResumeVariant',
  description: '',
  fields: [{ key: 'name', label: 'Name', kind: 'text' }],
  icon: 'file-text',
  label: 'Resume variants',
  orderBy: 'updated_at DESC',
  singularLabel: 'Resume variant',
  slug: 'resume-variants',
  tableColumns: ['name'],
};

const skillResource: AdminResource = {
  className: 'SkillCategoryMember',
  description: '',
  fields: [
    { key: 'tagId', label: 'SMRT tag ID', kind: 'text' },
    { key: 'categoryId', label: 'Category', kind: 'text' },
    { key: 'label', label: 'Label', kind: 'text' },
    {
      defaultValue: true,
      key: 'useOnResume',
      kind: 'checkbox',
      label: 'Use on resume',
    },
    { key: 'sortOrder', label: 'Sort order', kind: 'number' },
  ],
  icon: 'tag',
  label: 'Skills',
  orderBy: 'sortOrder ASC',
  singularLabel: 'skill',
  slug: 'skills',
  tableColumns: ['tagId'],
};

describe('parseResourceForm', () => {
  beforeEach(() => {
    smrtMock.collections.clear();
  });

  it('coerces admin form values into SMRT object payloads', () => {
    const form = new FormData();
    form.set('title', 'Platform Engineer');
    form.set('salaryMin', '150000');
    form.set('greenfieldSignal', 'on');
    form.set('postedAt', '2026-05-25T10:30');
    form.set('startDate', '2026-05-01');

    const payload = parseResourceForm(resource, form);

    expect(payload.title).toBe('Platform Engineer');
    expect(payload.salaryMin).toBe(150000);
    expect(payload.greenfieldSignal).toBe(true);
    expect(payload.postedAt).toBeInstanceOf(Date);
    expect(payload.startDate).toBeInstanceOf(Date);
  });

  it('keeps empty optional numeric and date fields nullable', () => {
    const form = new FormData();
    form.set('title', 'Platform Engineer');

    const payload = parseResourceForm(resource, form);

    expect(payload.salaryMin).toBeNull();
    expect(payload.postedAt).toBeNull();
    expect(payload.startDate).toBeNull();
    expect(payload.greenfieldSignal).toBe(false);
  });

  it('coerces select fields flagged coerce:number (blank -> null)', () => {
    const filled = new FormData();
    filled.set('title', 'Platform Engineer');
    filled.set('humanRating', '3');
    expect(parseResourceForm(resource, filled).humanRating).toBe(3);

    const blank = new FormData();
    blank.set('title', 'Platform Engineer');
    blank.set('humanRating', '');
    expect(parseResourceForm(resource, blank).humanRating).toBeNull();
  });

  it('normalizes list and JSON fields before creating admin records', async () => {
    const preferenceResource: AdminResource = {
      className: 'PreferenceRule',
      description: '',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        { key: 'ruleJson', label: 'Rule JSON', kind: 'textarea' },
      ],
      icon: 'sliders',
      label: 'Preference rules',
      orderBy: 'updated_at DESC',
      singularLabel: 'Preference rule',
      slug: 'preference-rules',
      tableColumns: ['name'],
    };
    const preferences = mockCollection();
    smrtMock.collections.set('PreferenceRule', preferences);

    const form = new FormData();
    form.set('name', 'Comp floor');
    form.set('ruleJson', '{ "currency": "USD", "annualMin": 130000 }');

    await createAdminRecord(preferenceResource, form);

    expect(preferences.created[0]).toMatchObject({
      ruleJson: '{"annualMin":130000,"currency":"USD"}',
    });

    const opportunities = mockCollection();
    smrtMock.collections.set('Opportunity', opportunities);
    const opportunityForm = new FormData();
    opportunityForm.set('title', 'Platform Engineer');
    opportunityForm.set(
      'requiredSkills',
      ' TypeScript \n\nSvelte\nTypeScript ',
    );

    await createAdminRecord(resource, opportunityForm);

    expect(opportunities.created[0]).toMatchObject({
      requiredSkills: 'TypeScript\nSvelte',
    });
  });
});

describe('createAdminRecord combo fields', () => {
  beforeEach(() => {
    smrtMock.collections.clear();
    scheduleMock.deleteSourceSchedule.mockClear();
    scheduleMock.syncSourceSchedule.mockClear();
    resumeVariantWorkflowMock.resumeVariantDeleteViolation.mockReset();
    resumeVariantWorkflowMock.resumeVariantDeleteViolation.mockResolvedValue(
      '',
    );
    resumeVariantWorkflowMock.resumeVariantWriteViolation.mockReset();
    resumeVariantWorkflowMock.resumeVariantWriteViolation.mockResolvedValue('');
    resumeVariantWorkflowMock.releaseResumeVariantApplicationWrite.mockClear();
    resumeVariantWorkflowMock.reserveResumeVariantApplicationWrite.mockReset();
    resumeVariantWorkflowMock.reserveResumeVariantApplicationWrite.mockResolvedValue(
      { reservation: null, violation: '' },
    );
    resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals.mockReset();
    resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals.mockResolvedValue(
      {
        invalidated: 0,
        selected: 0,
      },
    );
    workflowMock.normalizeAccountStatus.mockClear();
    workflowMock.syncApplicationWorkflowTasks.mockClear();
    workflowMock.syncRecommendedOpportunityDecisionTasks.mockClear();
    workflowMock.syncSourceAccountTasks.mockClear();
    workflowMock.validateSubmittedApplicationPayload.mockClear();
  });

  it('reuses existing companies and writes the join snapshot', async () => {
    const resource: AdminResource = {
      className: 'ExperienceCompany',
      description: '',
      fields: [
        {
          combo: {
            className: 'Company',
            createKey: 'name',
            labelKey: 'name',
            snapshotKey: 'companyNameSnapshot',
          },
          key: 'companyId',
          kind: 'combo',
          label: 'Company',
        },
        {
          key: 'companyNameSnapshot',
          label: 'Company name snapshot',
          kind: 'text',
        },
      ],
      icon: 'building',
      label: 'Experience companies',
      orderBy: 'updated_at DESC',
      singularLabel: 'Experience company',
      slug: 'experience-companies',
      tableColumns: ['companyId'],
    };
    const companies = mockCollection([
      { companyKey: 'happy-vertical', id: 'company-1', name: 'Happy Vertical' },
    ]);
    const joins = mockCollection();
    smrtMock.collections.set('Company', companies);
    smrtMock.collections.set('ExperienceCompany', joins);

    const form = new FormData();
    form.set('companyId', 'happy vertical');

    await createAdminRecord(resource, form);

    expect(companies.create).not.toHaveBeenCalled();
    expect(joins.created[0]).toMatchObject({
      companyId: 'company-1',
      companyNameSnapshot: 'Happy Vertical',
    });
  });

  it('creates new roles inline before writing the join', async () => {
    const resource: AdminResource = {
      className: 'ExperienceRole',
      description: '',
      fields: [
        {
          combo: {
            className: 'EmploymentRole',
            createKey: 'label',
            labelKey: 'label',
            snapshotKey: 'roleSnapshot',
          },
          key: 'roleId',
          kind: 'combo',
          label: 'Role',
        },
        { key: 'roleSnapshot', label: 'Role snapshot', kind: 'text' },
      ],
      icon: 'briefcase',
      label: 'Experience roles',
      orderBy: 'updated_at DESC',
      singularLabel: 'Experience role',
      slug: 'experience-roles',
      tableColumns: ['roleId'],
    };
    const roles = mockCollection();
    const joins = mockCollection();
    smrtMock.collections.set('EmploymentRole', roles);
    smrtMock.collections.set('ExperienceRole', joins);

    const form = new FormData();
    form.set('roleId', 'Principal Engineer');

    await createAdminRecord(resource, form);

    expect(roles.created[0]).toMatchObject({
      label: 'Principal Engineer',
      roleKey: 'principal-engineer',
      roleSlug: 'principal-engineer',
    });
    expect(joins.created[0]).toMatchObject({
      roleId: '1',
      roleSnapshot: 'Principal Engineer',
    });
  });

  it('rejects missing existing-only combo records', async () => {
    const resource: AdminResource = {
      className: 'Opportunity',
      description: '',
      fields: [
        {
          combo: {
            allowCreate: false,
            className: 'Source',
            labelKey: 'name',
          },
          key: 'sourceId',
          kind: 'combo',
          label: 'Source',
        },
      ],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['sourceId'],
    };
    const sources = mockCollection([{ id: 'source-1', name: 'Greenhouse' }]);
    const opportunities = mockCollection();
    smrtMock.collections.set('Source', sources);
    smrtMock.collections.set('Opportunity', opportunities);

    const form = new FormData();
    form.set('sourceId', 'Unknown source');

    await expect(createAdminRecord(resource, form)).rejects.toMatchObject({
      body: { message: 'Source not found: Unknown source' },
      status: 400,
    });
    expect(opportunities.create).not.toHaveBeenCalled();
  });

  it('lists and resolves context-qualified canonical SMRT tags', async () => {
    const resource: AdminResource = {
      className: 'AchievementTag',
      description: '',
      fields: [
        {
          combo: {
            allowCreate: false,
            className: 'Tag',
            displayKeys: ['context', 'name', 'slug'],
            labelKey: 'name',
            valueKey: 'id',
          },
          key: 'tagId',
          kind: 'combo',
          label: 'Tag',
        },
      ],
      icon: 'tag',
      label: 'Achievement tags',
      orderBy: 'updated_at DESC',
      singularLabel: 'achievement tag',
      slug: 'achievement-tags',
      tableColumns: ['tagId'],
    };
    const tags = mockCollection([
      {
        context: 'skill',
        id: 'tag-vue-skill',
        name: 'Vue.js',
        slug: 'vue',
      },
      {
        context: 'domain',
        id: 'tag-vue-domain',
        name: 'Vue.js',
        slug: 'vue',
      },
    ]);
    const joins = mockCollection();
    smrtMock.collections.set('Tag', tags);
    smrtMock.collections.set('AchievementTag', joins);

    await expect(listComboOptions(resource)).resolves.toEqual({
      tagId: [
        expect.objectContaining({
          label: 'skill · Vue.js · vue',
          value: 'tag-vue-skill',
        }),
        expect.objectContaining({
          label: 'domain · Vue.js · vue',
          value: 'tag-vue-domain',
        }),
      ],
    });

    const form = new FormData();
    form.set('tagId', 'domain · Vue.js · vue');
    await createAdminRecord(resource, form);

    expect(joins.created[0]).toMatchObject({ tagId: 'tag-vue-domain' });
    expect(tags.create).not.toHaveBeenCalled();
  });

  it('loads reference labels and canonical hrefs for resource fields', async () => {
    const sources = mockCollection([{ id: 'source-1', name: 'Greenhouse' }]);
    smrtMock.collections.set('Source', sources);

    const options = await listReferenceOptions({
      className: 'Opportunity',
      description: 'Opportunities',
      fields: [
        {
          key: 'sourceId',
          kind: 'text',
          label: 'Source ID',
        },
      ],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['sourceId'],
    });

    expect(options.sourceId).toEqual([
      {
        href: '/admin/sources/source-1',
        label: 'Greenhouse',
        value: 'source-1',
      },
    ]);
  });

  it('filters application-owned material derivatives from general asset lists', async () => {
    smrtMock.collections.set(
      'ResumeAsset',
      mockCollection([
        { applicationId: '', id: 'global-resume', title: 'Global resume' },
        { applicationId: 'app-1', id: 'app-resume', title: 'App resume' },
      ]),
    );

    await expect(
      listAdminRecords({
        className: 'ResumeAsset',
        description: 'Assets',
        fields: [],
        icon: 'file-text',
        label: 'Assets',
        orderBy: 'updated_at DESC',
        singularLabel: 'asset',
        slug: 'resume-assets',
        tableColumns: ['title'],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'global-resume',
        title: 'Global resume',
      }),
    ]);
  });

  it('rejects generic admin writes to application-owned materials', async () => {
    const assetResource = getAdminResource('resume-assets');
    if (!assetResource) throw new Error('Expected resume assets resource.');
    const assets = mockCollection([
      { applicationId: 'app-1', id: 'asset-1', title: 'Reviewed resume' },
    ]);
    smrtMock.collections.set('ResumeAsset', assets);

    const form = new FormData();
    form.set('id', 'asset-1');
    form.set('title', 'Changed after review');
    await expect(updateAdminRecord(assetResource, form)).rejects.toMatchObject({
      body: {
        message:
          'Application-owned materials are immutable through generic admin editing. Regenerate or revise them through the application workflow.',
      },
      status: 403,
    });
    await expect(deleteAdminRecord(assetResource, form)).rejects.toMatchObject({
      status: 403,
    });

    expect((await assets.get('asset-1'))?.save).not.toHaveBeenCalled();
    expect(assets.delete).not.toHaveBeenCalled();
  });

  it('does not let a stale admin application update restore final approval', async () => {
    const applications = mockCollection([
      {
        finalApprovalAt: '2026-06-04T10:00:00.000Z',
        finalApprovalKind: 'final_submission',
        finalApprovedByUserId: 'user-1',
        id: 'app-1',
        notes: 'Current review state',
        status: 'approved',
      },
    ]);
    smrtMock.collections.set('Application', applications);
    applicationConcurrencyMock.commitApplicationIfCurrent.mockResolvedValueOnce(
      false,
    );
    const applicationResource: AdminResource = {
      className: 'Application',
      description: '',
      fields: [{ key: 'notes', kind: 'textarea', label: 'Notes' }],
      icon: 'briefcase',
      label: 'Applications',
      orderBy: 'updated_at DESC',
      singularLabel: 'application',
      slug: 'applications',
      tableColumns: ['notes'],
    };
    const form = new FormData();
    form.set('id', 'app-1');
    form.set('notes', 'Stale edit');

    await expect(
      updateAdminRecord(applicationResource, form, { id: 'user-1' }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed before this update could be saved. Reload and review the current application.',
      },
      status: 409,
    });
    expect(await applications.get('app-1')).toMatchObject({
      finalApprovalKind: 'final_submission',
      notes: 'Current review state',
      status: 'approved',
    });
  });

  it('rejects generic admin creation or ownership transfer of application materials', async () => {
    const assetResource = getAdminResource('resume-assets');
    if (!assetResource) throw new Error('Expected resume assets resource.');
    const assets = mockCollection([
      { applicationId: '', id: 'asset-1', title: 'Global resume' },
    ]);
    smrtMock.collections.set('ResumeAsset', assets);

    const createForm = new FormData();
    createForm.set('applicationId', 'app-1');
    createForm.set('title', 'Bypass material');
    await expect(
      createAdminRecord(assetResource, createForm),
    ).rejects.toMatchObject({ status: 403 });

    const updateForm = new FormData();
    updateForm.set('applicationId', 'app-1');
    updateForm.set('id', 'asset-1');
    updateForm.set('title', 'Transferred material');
    await expect(
      updateAdminRecord(assetResource, updateForm),
    ).rejects.toMatchObject({ status: 403 });
    expect(assets.create).not.toHaveBeenCalled();
    expect((await assets.get('asset-1'))?.save).not.toHaveBeenCalled();
  });

  it('loads admin records with explicit paging and filter options', async () => {
    const opportunities = mockCollection([
      { humanReviewStatus: 'apply', id: 'opp-1', title: 'One' },
      { humanReviewStatus: 'maybe', id: 'opp-2', title: 'Two' },
      { humanReviewStatus: 'apply', id: 'opp-3', title: 'Three' },
    ]);
    smrtMock.collections.set('Opportunity', opportunities);

    await expect(
      listAdminRecords(resource, {
        limit: 1,
        offset: 1,
        select: ['id', 'title'],
        where: { humanReviewStatus: 'apply' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'opp-3',
        title: 'Three',
      }),
    ]);
    expect(opportunities.list).toHaveBeenCalledWith({
      limit: 1,
      offset: 1,
      orderBy: 'updated_at DESC',
      select: ['id', 'title'],
      where: { humanReviewStatus: 'apply' },
    });

    await expect(
      countAdminResourceRecords(resource, {
        where: { humanReviewStatus: 'apply' },
      }),
    ).resolves.toBe(2);
    expect(opportunities.count).toHaveBeenCalledWith({
      where: { humanReviewStatus: 'apply' },
    });
  });

  it('uses valid CompanyResearch fields for opportunity-company references', async () => {
    const companyResearch = mockCollection([
      {
        id: 'research-1',
        researchStatus: 'complete',
        websiteUrl: 'https://example.invalid',
      },
    ]);
    smrtMock.collections.set('CompanyResearch', companyResearch);

    const resource = getAdminResource('opportunity-companies');
    if (!resource) throw new Error('Expected opportunity companies resource.');

    const options = await listReferenceOptions({
      ...resource,
      fields: resource.fields.filter(
        (field) => field.key === 'companyResearchId',
      ),
    });

    expect(companyResearch.list).toHaveBeenCalledWith({
      limit: 1000,
      orderBy: 'websiteUrl ASC',
    });
    expect(options.companyResearchId).toEqual([
      {
        href: '/admin/company-research/research-1',
        label: 'https://example.invalid',
        value: 'research-1',
      },
    ]);
  });

  it('falls back to serialized list records when direct record lookup misses', async () => {
    const opportunities = mockCollection([
      { id: 'sample-opportunity', title: 'Sample opportunity' },
    ]);
    opportunities.get.mockResolvedValueOnce(null);
    smrtMock.collections.set('Opportunity', opportunities);

    await expect(
      getAdminRecord(resource, 'sample-opportunity'),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'sample-opportunity',
        title: 'Sample opportunity',
      }),
    );
    expect(opportunities.list).toHaveBeenCalledWith({
      limit: 1000,
      orderBy: 'updated_at DESC',
    });
  });

  it('syncs recommendation review tasks after creating and updating opportunities', async () => {
    const resource: AdminResource = {
      className: 'Opportunity',
      description: '',
      fields: [
        { key: 'title', label: 'Title', kind: 'text' },
        {
          key: 'status',
          label: 'Status',
          kind: 'select',
          options: ['found', 'recommended'],
        },
      ],
      icon: 'briefcase',
      label: 'Opportunities',
      orderBy: 'updated_at DESC',
      singularLabel: 'Opportunity',
      slug: 'opportunities',
      tableColumns: ['title'],
    };
    const opportunities = mockCollection([
      { id: 'opp-1', status: 'found', title: 'Platform Engineer' },
    ]);
    smrtMock.collections.set('Opportunity', opportunities);

    const createForm = new FormData();
    createForm.set('title', 'AI Engineer');
    createForm.set('status', 'recommended');
    await createAdminRecord(resource, createForm);

    const updateForm = new FormData();
    updateForm.set('id', 'opp-1');
    updateForm.set('title', 'Platform Engineer');
    updateForm.set('status', 'recommended');
    await updateAdminRecord(resource, updateForm);

    expect(
      workflowMock.syncRecommendedOpportunityDecisionTasks,
    ).toHaveBeenCalledTimes(2);
  });

  it('syncs selected application approvals after creating and updating resume variants', async () => {
    const variants = mockCollection([
      { id: 'variant-1', name: 'Approved variant' },
    ]);
    smrtMock.collections.set('ResumeVariant', variants);

    const createForm = new FormData();
    createForm.set('name', 'New variant');
    await createAdminRecord(resumeVariantResource, createForm);

    expect(
      resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('2');

    const updateForm = new FormData();
    updateForm.set('id', 'variant-1');
    updateForm.set('name', 'Renamed variant');
    await updateAdminRecord(resumeVariantResource, updateForm);

    expect(
      resumeVariantWorkflowMock.reserveResumeVariantApplicationWrite,
    ).toHaveBeenCalledWith('variant-1');
    expect(
      resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals,
    ).toHaveBeenCalledWith('variant-1');
  });

  it('rejects unsafe admin resume variant updates before saving', async () => {
    const variants = mockCollection([
      { id: 'variant-1', name: 'Approved variant' },
    ]);
    smrtMock.collections.set('ResumeVariant', variants);
    resumeVariantWorkflowMock.reserveResumeVariantApplicationWrite.mockResolvedValueOnce(
      {
        reservation: null,
        violation:
          'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
      },
    );

    const form = new FormData();
    form.set('id', 'variant-1');
    form.set('name', 'Changed variant');

    await expect(
      updateAdminRecord(resumeVariantResource, form),
    ).rejects.toMatchObject({
      body: {
        message:
          'Submitted, closed, or in-progress applications cannot have selected resume variants changed.',
      },
      status: 409,
    });

    expect(variants.get).toHaveBeenCalledWith('variant-1');
    expect(variants.created).toHaveLength(0);
    expect((await variants.get('variant-1'))?.save).not.toHaveBeenCalled();
    expect(
      resumeVariantWorkflowMock.syncResumeVariantApplicationApprovals,
    ).not.toHaveBeenCalled();
  });

  it('rejects deleting selected admin resume variants', async () => {
    const variants = mockCollection([
      { id: 'variant-1', name: 'Selected variant' },
    ]);
    smrtMock.collections.set('ResumeVariant', variants);
    resumeVariantWorkflowMock.resumeVariantDeleteViolation.mockResolvedValueOnce(
      'Resume variant is selected by an application and cannot be deleted.',
    );

    const form = new FormData();
    form.set('id', 'variant-1');

    await expect(
      deleteAdminRecord(resumeVariantResource, form),
    ).rejects.toMatchObject({
      body: {
        message:
          'Resume variant is selected by an application and cannot be deleted.',
      },
      status: 400,
    });

    expect(variants.delete).not.toHaveBeenCalled();
  });

  it('keeps AgentRun audit records read-only in admin mutations', async () => {
    const agentRunResource = getAdminResource('agent-runs');
    if (!agentRunResource) throw new Error('Expected agent runs resource.');
    const agentRuns = mockCollection([{ id: 'run-1', status: 'succeeded' }]);
    smrtMock.collections.set('AgentRun', agentRuns);

    await expect(
      createAdminRecord(agentRunResource, new FormData()),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });

    const updateForm = new FormData();
    updateForm.set('id', 'run-1');
    await expect(
      updateAdminRecord(agentRunResource, updateForm),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });

    const deleteForm = new FormData();
    deleteForm.set('id', 'run-1');
    await expect(
      deleteAdminRecord(agentRunResource, deleteForm),
    ).rejects.toMatchObject({
      body: {
        message: 'Agent run audit records are system-authored and immutable.',
      },
      status: 403,
    });

    expect(agentRuns.create).not.toHaveBeenCalled();
    expect(agentRuns.delete).not.toHaveBeenCalled();
  });

  it.each([
    'source-crawls',
    'source-crawl-items',
  ])('keeps %s accounting records read-only in admin mutations', async (slug) => {
    const resource = getAdminResource(slug);
    if (!resource) throw new Error(`Expected ${slug} resource.`);
    const records = mockCollection([{ id: 'accounting-1' }]);
    smrtMock.collections.set(resource.className, records);
    const rejection = {
      body: {
        message:
          'Source crawl accounting records are system-authored and immutable.',
      },
      status: 403,
    };

    await expect(
      createAdminRecord(resource, new FormData()),
    ).rejects.toMatchObject(rejection);
    const form = new FormData();
    form.set('id', 'accounting-1');
    await expect(updateAdminRecord(resource, form)).rejects.toMatchObject(
      rejection,
    );
    await expect(deleteAdminRecord(resource, form)).rejects.toMatchObject(
      rejection,
    );
    expect(records.create).not.toHaveBeenCalled();
    expect(records.delete).not.toHaveBeenCalled();
  });

  it('queues a canonical resume refresh after resume source writes', async () => {
    const skills = mockCollection([
      {
        categoryId: 'category-1',
        id: 'skill-1',
        label: 'TypeScript',
        sortOrder: 0,
        tagId: 'typescript',
        useOnResume: true,
      },
    ]);
    const achievements = mockCollection();
    smrtMock.collections.set('SkillCategoryMember', skills);
    smrtMock.collections.set('Achievement', achievements);

    const createForm = new FormData();
    createForm.set('tagId', 'svelte');
    createForm.set('categoryId', 'category-1');
    createForm.set('label', 'Svelte');
    createForm.set('useOnResume', 'on');
    createForm.set('sortOrder', '1');
    await createAdminRecord(skillResource, createForm);

    const updateForm = new FormData();
    updateForm.set('id', 'skill-1');
    updateForm.set('tagId', 'typescript');
    updateForm.set('categoryId', 'category-1');
    updateForm.set('label', 'TypeScript');
    updateForm.set('sortOrder', '0');
    await updateAdminRecord(skillResource, updateForm);

    const deleteForm = new FormData();
    deleteForm.set('id', 'skill-1');
    await deleteAdminRecord(skillResource, deleteForm);

    const achievementResource: AdminResource = {
      className: 'Achievement',
      description: '',
      fields: [
        { key: 'experienceId', label: 'Experience', kind: 'text' },
        { key: 'projectId', label: 'Project', kind: 'text' },
        { key: 'title', label: 'Title', kind: 'text' },
        { key: 'body', label: 'Body', kind: 'textarea' },
      ],
      icon: 'file-text',
      label: 'Achievements',
      orderBy: 'sortOrder ASC',
      singularLabel: 'achievement',
      slug: 'achievements',
      tableColumns: ['title'],
    };
    const achievementForm = new FormData();
    achievementForm.set('experienceId', 'experience-1');
    achievementForm.set('projectId', 'project-1');
    achievementForm.set('title', 'Project bullet');
    achievementForm.set('body', 'Edited inline from the experience page.');
    await createAdminRecord(achievementResource, achievementForm);

    expect(
      resumeRefreshMock.invalidatePublishedResumeCache,
    ).toHaveBeenCalledTimes(4);
    expect(
      resumeRefreshMock.queuePublishedCanonicalRefresh,
    ).toHaveBeenCalledTimes(4);
  });

  it('does not queue canonical resume refreshes for non-resume resources', async () => {
    const opportunities = mockCollection([{ id: 'opp-1', title: 'One' }]);
    smrtMock.collections.set('Opportunity', opportunities);

    const form = new FormData();
    form.set('id', 'opp-1');
    form.set('title', 'One');
    await updateAdminRecord(resource, form);

    expect(
      resumeRefreshMock.invalidatePublishedResumeCache,
    ).not.toHaveBeenCalled();
    expect(
      resumeRefreshMock.queuePublishedCanonicalRefresh,
    ).not.toHaveBeenCalled();
  });

  it('syncs source schedules after creating a source', async () => {
    const resource: AdminResource = {
      className: 'Source',
      description: '',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        {
          key: 'refreshCadence',
          label: 'Refresh cadence',
          kind: 'select',
          options: ['daily', 'weekly', 'monthly', 'ad_hoc'],
        },
        { key: 'isActive', label: 'Active', kind: 'checkbox' },
      ],
      icon: 'rss',
      label: 'Sources',
      orderBy: 'updated_at DESC',
      singularLabel: 'Source',
      slug: 'sources',
      tableColumns: ['name'],
    };
    const sources = mockCollection();
    smrtMock.collections.set('Source', sources);

    const form = new FormData();
    form.set('name', 'Greenhouse');
    form.set('refreshCadence', 'daily');
    form.set('isActive', 'on');

    await createAdminRecord(resource, form);

    expect(scheduleMock.syncSourceSchedule).toHaveBeenCalledWith(
      sources.created[0],
    );
    expect(workflowMock.syncSourceAccountTasks).toHaveBeenCalledWith(
      sources.created[0],
    );
  });

  it('rejects invalid source account status before creating admin records', async () => {
    const resource: AdminResource = {
      className: 'Source',
      description: '',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        {
          key: 'accountStatus',
          label: 'Account status',
          kind: 'select',
          options: ['unknown', 'needs_2fa'],
        },
      ],
      icon: 'rss',
      label: 'Sources',
      orderBy: 'updated_at DESC',
      singularLabel: 'Source',
      slug: 'sources',
      tableColumns: ['name'],
    };
    const sources = mockCollection();
    smrtMock.collections.set('Source', sources);

    const form = new FormData();
    form.set('name', 'Greenhouse');
    form.set('accountStatus', 'needs_magic');

    await expect(createAdminRecord(resource, form)).rejects.toMatchObject({
      body: { message: 'Invalid account status.' },
      status: 400,
    });

    expect(sources.create).not.toHaveBeenCalled();
    expect(scheduleMock.syncSourceSchedule).not.toHaveBeenCalled();
    expect(workflowMock.syncSourceAccountTasks).not.toHaveBeenCalled();
  });

  it('syncs source schedules after updating a source', async () => {
    const resource: AdminResource = {
      className: 'Source',
      description: '',
      fields: [
        { key: 'name', label: 'Name', kind: 'text' },
        {
          key: 'refreshCadence',
          label: 'Refresh cadence',
          kind: 'select',
          options: ['daily', 'weekly', 'monthly', 'ad_hoc'],
        },
        { key: 'isActive', label: 'Active', kind: 'checkbox' },
      ],
      icon: 'rss',
      label: 'Sources',
      orderBy: 'updated_at DESC',
      singularLabel: 'Source',
      slug: 'sources',
      tableColumns: ['name'],
    };
    const sources = mockCollection([
      {
        id: 'source-1',
        isActive: true,
        name: 'Greenhouse',
        refreshCadence: 'weekly',
      },
    ]);
    smrtMock.collections.set('Source', sources);

    const form = new FormData();
    form.set('id', 'source-1');
    form.set('name', 'Greenhouse');
    form.set('refreshCadence', 'monthly');
    form.set('isActive', 'on');

    await updateAdminRecord(resource, form);

    expect(scheduleMock.syncSourceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source-1', refreshCadence: 'monthly' }),
    );
    expect(workflowMock.syncSourceAccountTasks).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source-1', refreshCadence: 'monthly' }),
    );
  });

  it('removes source schedules after deleting a source', async () => {
    const resource: AdminResource = {
      className: 'Source',
      description: '',
      fields: [{ key: 'name', label: 'Name', kind: 'text' }],
      icon: 'rss',
      label: 'Sources',
      orderBy: 'updated_at DESC',
      singularLabel: 'Source',
      slug: 'sources',
      tableColumns: ['name'],
    };
    const sources = mockCollection([{ id: 'source-1', name: 'Greenhouse' }]);
    smrtMock.collections.set('Source', sources);

    const form = new FormData();
    form.set('id', 'source-1');

    await deleteAdminRecord(resource, form);

    expect(sources.delete).toHaveBeenCalledWith('source-1');
    expect(scheduleMock.deleteSourceSchedule).toHaveBeenCalledWith('source-1');
  });
});

describe('assertAdminWorkflowPayload', () => {
  const applicationResource: AdminResource = {
    className: 'Application',
    description: '',
    fields: [],
    icon: 'send',
    label: 'Applications',
    orderBy: 'updated_at DESC',
    singularLabel: 'Application',
    slug: 'applications',
    tableColumns: ['status'],
  };

  function expectHttpError(action: () => void, message: string) {
    let thrown: unknown;
    try {
      action();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      body: { message },
      status: 400,
    });
  }

  it('requires a user-backed approval for approved applications', () => {
    const now = new Date('2026-06-04T12:00:00.000Z');

    expectHttpError(
      () =>
        assertAdminWorkflowPayload(applicationResource, { status: 'approved' }),
      'Application approval requires an authenticated user.',
    );
    expectHttpError(
      () =>
        assertAdminWorkflowPayload(
          applicationResource,
          {
            approvedByUserId: 'user-2',
            status: 'approved',
          },
          { id: 'user-1' },
        ),
      'Application approval requires approvedByUserId matching the authenticated user.',
    );

    expectHttpError(
      () =>
        assertAdminWorkflowPayload(
          applicationResource,
          { status: 'submitted' },
          { id: 'user-1' },
        ),
      'Application submission must be recorded from the application review page.',
    );

    const payload: Record<string, unknown> = {
      approvedByUserId: '   ',
      status: 'approved',
    };
    expect(() =>
      assertAdminWorkflowPayload(
        applicationResource,
        payload,
        { id: 'user-1' },
        null,
        now,
      ),
    ).not.toThrow();
    expect(payload.approvedByUserId).toBe('user-1');
    expect(payload.approvedAt).toEqual(now);
    expect(() =>
      assertAdminWorkflowPayload(
        applicationResource,
        {
          approvedByUserId: 'user-1',
          status: 'approved',
        },
        { id: 'user-1' },
      ),
    ).not.toThrow();
  });

  it('rejects invalid application statuses and unsafe status jumps', () => {
    expectHttpError(
      () =>
        assertAdminWorkflowPayload(applicationResource, { status: 'missing' }),
      'Invalid application status: missing.',
    );
    expectHttpError(
      () =>
        assertAdminWorkflowPayload(
          applicationResource,
          { approvedByUserId: 'user-1', status: 'submitted' },
          { id: 'user-1' },
          { approvedByUserId: '', id: 'app-1', status: 'draft' },
        ),
      'Application submission must be recorded from the application review page.',
    );

    const payload: Record<string, unknown> = {
      approvedByUserId: '',
      status: 'approved',
    };
    expect(() =>
      assertAdminWorkflowPayload(
        applicationResource,
        payload,
        { id: 'user-1' },
        { id: 'app-1', status: 'awaiting_user' },
      ),
    ).not.toThrow();
    expect(payload).toMatchObject({
      approvedByUserId: 'user-1',
      status: 'approved',
    });
  });

  it('clears approval when approved application materials change', () => {
    const payload: Record<string, unknown> = { resumeAssetId: 'resume-new' };

    expect(() =>
      assertAdminWorkflowPayload(applicationResource, payload, undefined, {
        approvedAt: new Date('2026-06-04T12:00:00.000Z'),
        approvedByProfileId: 'profile-1',
        approvedByUserId: 'user-1',
        id: 'app-1',
        resumeAssetId: 'resume-old',
        status: 'approved',
      }),
    ).not.toThrow();

    expect(payload).toMatchObject({
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      resumeAssetId: 'resume-new',
      status: 'awaiting_user',
    });
  });

  it('rejects material changes after submission', () => {
    expectHttpError(
      () =>
        assertAdminWorkflowPayload(
          applicationResource,
          { packetAssetId: 'packet-new' },
          undefined,
          {
            id: 'app-1',
            packetAssetId: 'packet-old',
            status: 'submitted',
          },
        ),
      'Submitted or closed applications cannot have their approved materials changed.',
    );
  });
});
