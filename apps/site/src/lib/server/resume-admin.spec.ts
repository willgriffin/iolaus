import type { FilesystemInterface } from '@happyvertical/files';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePublishedResumePdf,
  generateResumeAsset,
  loadPublishedResumePdf,
  loadResumeAssetPreviews,
  nextPublishedAssetStates,
  publishResumeAsset,
  refreshPublishedCanonicalResumeAsset,
  regenerateResumeAsset,
} from './resume-admin';
import {
  CURRENT_RESUME_PDF_BASENAME,
  CURRENT_RESUME_PDF_PATH,
  PUBLISHED_RESUME_PDF_PATH,
} from './resume-files';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};

function record(data: Record<string, unknown>): MockRecord {
  return {
    id: String(data.id ?? 'record-1'),
    save: vi.fn(async () => {}),
    ...data,
  } as MockRecord;
}

function collection(records: MockRecord[] = []) {
  return {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    delete: vi.fn(async (id: string) => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    }),
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async (options?: { limit?: number; offset?: number }) => {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? records.length;
      return records.slice(offset, offset + limit);
    }),
    records,
  };
}

const mocks = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof collection>>(),
  generateResumeArtifacts: vi.fn(async () => ({
    htmlPath: 'generated-resumes/created-2/resume.html',
    markdownPath: 'generated-resumes/created-2/resume.md',
    outputPrefix: 'resume.canonical',
    pdfBasename: 'resume.pdf',
    pdfPath: 'generated-resumes/created-2/resume.pdf',
    slug: 'canonical',
    source: {},
    textPath: 'generated-resumes/created-2/resume.txt',
  })),
  getDefaultPuppeteerExecutablePath: vi.fn(async () => undefined),
  getResumeFilesystem: vi.fn(async () => ({})),
  getResumeTailoringConfig: vi.fn(),
  loadPublishedResumeSource: vi.fn(),
  requestScopedDatabase: vi.fn(),
  resolveDatabase: vi.fn(),
  publishedAsset: {
    id: 'legacy-current',
    pdfBasename: 'resume.pdf',
    pdfPath: 'generated-resumes/legacy-current/resume.pdf',
  } as { id: string; pdfBasename: string; pdfPath: string } | null,
  shouldThrowPublishedAsset: false,
  shouldThrowResumeAssetList: false,
}));

vi.mock('./resume-data.js', () => ({
  getPublishedResumeAsset: vi.fn(async () => {
    if (mocks.shouldThrowPublishedAsset) {
      throw new Error('Database unavailable');
    }
    return (
      mocks.collections
        .get('ResumeAsset')
        ?.records.find((asset) => asset.isPublished) ?? mocks.publishedAsset
    );
  }),
  getResumeTailoringConfig: mocks.getResumeTailoringConfig,
  listResumeAssets: vi.fn(async () => {
    if (mocks.shouldThrowResumeAssetList) {
      throw new Error('Resume history unavailable');
    }
    return mocks.collections.get('ResumeAsset')?.records ?? [];
  }),
  listResumeTailoringConfigs: vi.fn(),
  loadPublishedResumeSource: mocks.loadPublishedResumeSource,
  parseTailoringConfigRecord: vi.fn((record: Record<string, unknown>) => ({
    ...record,
    config: JSON.parse(String(record.configJson ?? '{}')),
  })),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
}));

vi.mock('@happyvertical/smrt-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-core')>();
  return { ...actual, resolveDatabase: mocks.resolveDatabase };
});

vi.mock('@happyvertical/smrt-users', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-users')>();
  return {
    ...actual,
    getRequestScopedDatabase: mocks.requestScopedDatabase,
  };
});

vi.mock('@willgriffin/iolaus-resume', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@willgriffin/iolaus-resume')>();
  return {
    ...actual,
    generateResumeArtifacts: mocks.generateResumeArtifacts,
    getDefaultPuppeteerExecutablePath: mocks.getDefaultPuppeteerExecutablePath,
  };
});

vi.mock('./resume-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resume-files.js')>();
  return { ...actual, getResumeFilesystem: mocks.getResumeFilesystem };
});

beforeEach(() => {
  mocks.collections.clear();
  mocks.generateResumeArtifacts.mockClear();
  mocks.generateResumeArtifacts.mockResolvedValue({
    htmlPath: 'generated-resumes/created-2/resume.html',
    markdownPath: 'generated-resumes/created-2/resume.md',
    outputPrefix: 'resume.canonical',
    pdfBasename: 'resume.pdf',
    pdfPath: 'generated-resumes/created-2/resume.pdf',
    slug: 'canonical',
    source: {},
    textPath: 'generated-resumes/created-2/resume.txt',
  });
  mocks.getDefaultPuppeteerExecutablePath.mockClear();
  mocks.getResumeFilesystem.mockClear();
  mocks.getResumeFilesystem.mockResolvedValue({});
  mocks.getResumeTailoringConfig.mockClear();
  mocks.getResumeTailoringConfig.mockResolvedValue(null);
  mocks.loadPublishedResumeSource.mockReset();
  mocks.loadPublishedResumeSource.mockResolvedValue({
    experience: { education: [], other: [], positions: [] },
    profile: {
      email: 'will@example.com',
      links: [],
      name: 'Example Candidate',
      summary: 'Builds systems.',
      title: 'Programmer',
    },
    skills: { groups: [], skillGroups: [] },
  });
  mocks.publishedAsset = {
    id: 'legacy-current',
    pdfBasename: 'resume.pdf',
    pdfPath: 'generated-resumes/legacy-current/resume.pdf',
  };
  mocks.shouldThrowPublishedAsset = false;
  mocks.shouldThrowResumeAssetList = false;
  mocks.requestScopedDatabase.mockReset();
  mocks.requestScopedDatabase.mockReturnValue(undefined);
  mocks.resolveDatabase.mockReset();
  mocks.resolveDatabase.mockResolvedValue({ url: 'test:' });
});

describe('nextPublishedAssetStates', () => {
  it('publishes exactly one selected resume asset', () => {
    const publishedAt = new Date('2026-05-25T12:00:00.000Z');

    expect(
      nextPublishedAssetStates(
        [
          { id: 'old', isPublished: true, status: 'published' },
          { id: 'next', isPublished: false, status: 'generated' },
          { id: 'failed', isPublished: false, status: 'failed' },
        ],
        'next',
        publishedAt,
      ),
    ).toEqual([
      { id: 'old', isPublished: false, publishedAt: null, status: 'generated' },
      { id: 'next', isPublished: true, publishedAt, status: 'published' },
      { id: 'failed', isPublished: false, publishedAt: null, status: 'failed' },
    ]);
  });
});

describe('publishResumeAsset', () => {
  it('rejects application-owned materials as canonical resume candidates', async () => {
    const applicationAsset = record({
      applicationId: 'app-1',
      id: 'application-resume',
      pdfPath: 'generated-resumes/application-resume/resume.pdf',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 application\n')),
      write: vi.fn(async () => {}),
    };
    mocks.collections.set('ResumeAsset', collection([applicationAsset]));

    await expect(
      publishResumeAsset(
        'application-resume',
        filesystem as unknown as FilesystemInterface,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(filesystem.read).not.toHaveBeenCalled();
    expect(filesystem.write).not.toHaveBeenCalled();
    expect(applicationAsset.save).not.toHaveBeenCalled();
  });
});

describe('loadResumeAssetPreviews', () => {
  it('loads available markdown and text artifacts and exposes the admin PDF URL', async () => {
    const filesystem = {
      exists: vi.fn(async (path: string) =>
        ['generated/resume.md', 'generated/resume.txt'].includes(path),
      ),
      read: vi.fn(async (path: string) =>
        path.endsWith('.md') ? '# Resume\n' : 'Resume text\n',
      ),
    };

    await expect(
      loadResumeAssetPreviews(
        [
          {
            id: 'asset-1',
            markdownPath: 'generated/resume.md',
            pdfPath: 'generated/resume.pdf',
            textPath: 'generated/resume.txt',
          },
        ],
        filesystem as unknown as FilesystemInterface,
      ),
    ).resolves.toMatchObject([
      {
        id: 'asset-1',
        markdownBody: '# Resume\n',
        markdownStatus: 'available',
        pdfHref: '/admin/resume-assets/asset-1/pdf',
        textBody: 'Resume text\n',
        textStatus: 'available',
      },
    ]);
  });

  it('marks missing artifact files without failing the admin page', async () => {
    const filesystem = {
      exists: vi.fn(async () => false),
      read: vi.fn(async () => {
        throw new Error('missing');
      }),
    };

    await expect(
      loadResumeAssetPreviews(
        [
          {
            id: 'asset-1',
            markdownPath: 'generated/missing.md',
            pdfPath: '',
            textPath: 'generated/missing.txt',
          },
        ],
        filesystem as unknown as FilesystemInterface,
      ),
    ).resolves.toMatchObject([
      {
        markdownBody: '',
        markdownStatus: 'missing',
        pdfHref: '',
        textBody: '',
        textStatus: 'missing',
      },
    ]);
  });

  it('does not read artifact bodies until their tab is opened', async () => {
    const filesystem = {
      exists: vi.fn(async () => true),
      read: vi.fn(async () => 'should not be read'),
    };

    await expect(
      loadResumeAssetPreviews(
        [
          {
            id: 'asset-1',
            markdownPath: 'generated/resume.md',
            pdfPath: 'generated/resume.pdf',
            textPath: 'generated/resume.txt',
          },
        ],
        filesystem as unknown as FilesystemInterface,
        'none',
      ),
    ).resolves.toMatchObject([
      {
        markdownBody: '',
        markdownStatus: 'unloaded',
        textBody: '',
        textStatus: 'unloaded',
      },
    ]);
    expect(filesystem.exists).not.toHaveBeenCalled();
    expect(filesystem.read).not.toHaveBeenCalled();
  });
});

describe('loadPublishedResumePdf', () => {
  it('serves the bundled current resume when no published asset is available', async () => {
    mocks.publishedAsset = null;
    const read = vi.fn(async (path: string) => {
      if (path === CURRENT_RESUME_PDF_PATH) return Buffer.from('fallback pdf');
      throw new Error('File not found');
    });

    await expect(
      loadPublishedResumePdf({ read } as unknown as FilesystemInterface),
    ).resolves.toEqual({
      body: Buffer.from('fallback pdf'),
      filename: CURRENT_RESUME_PDF_BASENAME,
    });
    expect(read).toHaveBeenCalledWith(CURRENT_RESUME_PDF_PATH, { raw: true });
  });

  it('serves the bundled current resume when published asset lookup fails', async () => {
    mocks.shouldThrowPublishedAsset = true;
    const read = vi.fn(async (path: string) => {
      if (path === CURRENT_RESUME_PDF_PATH) return Buffer.from('fallback pdf');
      throw new Error('File not found');
    });

    await expect(
      loadPublishedResumePdf({ read } as unknown as FilesystemInterface),
    ).resolves.toEqual({
      body: Buffer.from('fallback pdf'),
      filename: CURRENT_RESUME_PDF_BASENAME,
    });
    expect(read).toHaveBeenCalledWith(CURRENT_RESUME_PDF_PATH, { raw: true });
  });

  it('uses the PDF selected by the published record instead of a stale alias', async () => {
    const read = vi.fn(async (path: string) => {
      if (path === 'generated-resumes/legacy-current/resume.pdf') {
        return Buffer.from('selected asset pdf');
      }
      if (path === PUBLISHED_RESUME_PDF_PATH) {
        return Buffer.from('stale alias pdf');
      }
      throw new Error('File not found');
    });

    await expect(
      loadPublishedResumePdf({ read } as unknown as FilesystemInterface),
    ).resolves.toEqual({
      body: Buffer.from('selected asset pdf'),
      filename: 'resume.pdf',
    });
    expect(read).toHaveBeenCalledWith(
      'generated-resumes/legacy-current/resume.pdf',
      { raw: true },
    );
    expect(read).not.toHaveBeenCalledWith(PUBLISHED_RESUME_PDF_PATH, {
      raw: true,
    });
  });

  it('returns null when the selected PDF and legacy alias are both missing', async () => {
    const read = vi.fn(async () => {
      throw new Error('File not found');
    });

    await expect(
      loadPublishedResumePdf({ read } as unknown as FilesystemInterface),
    ).resolves.toBeNull();
    expect(read).toHaveBeenCalledWith(
      'generated-resumes/legacy-current/resume.pdf',
      {
        raw: true,
      },
    );
    expect(read).toHaveBeenCalledWith('published/resume.pdf', { raw: true });
    expect(read).toHaveBeenCalledWith(CURRENT_RESUME_PDF_PATH, { raw: true });
  });
});

describe('publishResumeAsset', () => {
  it('does not replace the public alias when publication state cannot be saved', async () => {
    const candidate = record({
      id: 'candidate',
      pdfPath: 'generated-resumes/candidate/resume.pdf',
      status: 'generated',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 candidate\n')),
      write: vi.fn(async () => {}),
    };
    mocks.collections.set('ResumeAsset', collection([candidate]));
    mocks.shouldThrowResumeAssetList = true;

    await expect(
      publishResumeAsset(
        'candidate',
        filesystem as unknown as FilesystemInterface,
      ),
    ).rejects.toThrow('Resume history unavailable');

    expect(filesystem.write).not.toHaveBeenCalled();
  });

  it('keeps durable publication when the compatibility alias cannot be refreshed', async () => {
    const candidate = record({
      id: 'candidate',
      pdfPath: 'generated-resumes/candidate/resume.pdf',
      status: 'generated',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 candidate\n')),
      write: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    mocks.collections.set('ResumeAsset', collection([candidate]));

    await expect(
      publishResumeAsset(
        'candidate',
        filesystem as unknown as FilesystemInterface,
      ),
    ).resolves.toMatchObject({
      id: 'candidate',
      isPublished: true,
      status: 'published',
    });
    expect(candidate).toMatchObject({
      isPublished: true,
      status: 'published',
    });
  });
});

describe('generateResumeAsset canonical tailoring', () => {
  it('uses the stored canonical config without overwriting owner edits', async () => {
    const canonical = record({
      active: true,
      company: '',
      configJson: JSON.stringify({
        excludeSkillIds: ['cobol'],
        maxProjectsPerPosition: 4,
        name: 'Canonical resume',
        outputSlug: 'canonical',
      }),
      configSlug: 'canonical',
      id: 'canonical-1',
      name: 'Canonical resume',
    });
    const storedJson = canonical.configJson;
    const tailoringConfigs = collection([canonical]);
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 fresh\n')),
      write: vi.fn(async () => {}),
    };
    mocks.collections.set('ResumeAsset', collection());
    mocks.collections.set('ResumeTailoringConfig', tailoringConfigs);

    const result = await generateResumeAsset({
      filesystem: filesystem as unknown as FilesystemInterface,
      tailoringId: '',
    });

    expect(result).toMatchObject({ tailoringId: 'canonical-1' });
    expect(tailoringConfigs.create).not.toHaveBeenCalled();
    expect(canonical.save).not.toHaveBeenCalled();
    expect(canonical.configJson).toBe(storedJson);
    expect(mocks.generateResumeArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        tailoring: expect.objectContaining({
          excludeSkillIds: ['cobol'],
          maxProjectsPerPosition: 4,
        }),
      }),
    );
  });
});

describe('regenerateResumeAsset', () => {
  it('creates a fresh asset from the selected asset tailoring config', async () => {
    const sourceAsset = record({
      id: 'source-asset',
      tailoringId: 'tailoring-1',
      targetOpportunityId: 'opportunity-1',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 fresh\n')),
      write: vi.fn(async () => {}),
    };

    const resumeAssets = collection([sourceAsset]);
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.getResumeTailoringConfig.mockResolvedValueOnce({
      config: { name: 'Backend' },
      configSlug: 'backend',
      id: 'tailoring-1',
      name: 'Backend',
    });
    mocks.generateResumeArtifacts.mockResolvedValueOnce({
      htmlPath: 'generated-resumes/created-2/resume.backend.html',
      markdownPath: 'generated-resumes/created-2/resume.backend.md',
      outputPrefix: 'resume.backend',
      pdfBasename: '[resume] Example Candidate - Backend.pdf',
      pdfPath: 'generated-resumes/created-2/resume.pdf',
      slug: 'backend',
      source: {},
      textPath: 'generated-resumes/created-2/resume.backend.txt',
    });

    const result = await regenerateResumeAsset(
      'source-asset',
      filesystem as unknown as FilesystemInterface,
    );

    expect(result).toMatchObject({
      id: 'created-2',
      outputSlug: 'backend',
      tailoringId: 'tailoring-1',
      targetOpportunityId: 'opportunity-1',
      title: 'Resume - Backend',
    });
    expect(mocks.getResumeTailoringConfig).toHaveBeenCalledWith('tailoring-1');
    expect(resumeAssets.create).toHaveBeenCalledWith(
      expect.objectContaining({
        context: '',
        slug: expect.stringMatching(/^resume-/),
      }),
    );
    expect(mocks.generateResumeArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        outputDir: 'generated-resumes/created-2',
        tailoring: { name: 'Backend' },
        tailoringPath: 'backend',
      }),
    );
  });
});

describe('generateResumeAsset', () => {
  it('compensates a generated resume if its lifecycle lock is lost during save', async () => {
    const resumeAssets = collection();
    resumeAssets.create.mockImplementationOnce(async (payload) => {
      const asset = record({ id: 'resume-locked', ...payload });
      asset.save.mockImplementationOnce(async () => {
        lockActive = false;
      });
      resumeAssets.records.push(asset);
      return asset;
    });
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('ResumeTailoringConfig', collection());
    const filesystem = { delete: vi.fn(async () => {}) };
    let lockActive = true;
    const assertWriteAllowed = () => {
      if (lockActive) return;
      throw new Error('lifecycle lock lost');
    };

    await expect(
      generateResumeAsset({
        assertWriteAllowed,
        filesystem: filesystem as unknown as FilesystemInterface,
      }),
    ).rejects.toThrow('lifecycle lock lost');

    expect(resumeAssets.delete).toHaveBeenCalledWith('resume-locked');
    expect(resumeAssets.records).toHaveLength(0);
    expect(filesystem.delete).toHaveBeenCalledTimes(4);
  });

  it('records a failed asset when filesystem setup cannot start the renderer', async () => {
    const resumeAssets = collection();
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.getResumeFilesystem.mockRejectedValueOnce(
      new Error('resume storage is unavailable'),
    );

    await expect(generateResumeAsset()).rejects.toThrow(
      'resume storage is unavailable',
    );

    expect(resumeAssets.records).toHaveLength(1);
    expect(resumeAssets.records[0]).toMatchObject({
      notes: 'Resume generation failed before artifacts were saved.',
      status: 'failed',
    });
  });
});

describe('ensurePublishedResumePdf', () => {
  it('generates and publishes a canonical PDF when every stored copy is missing', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const files = new Map<string, Buffer>([
      [
        'generated-resumes/created-2/resume.pdf',
        Buffer.from('%PDF-1.4 fresh\n'),
      ],
    ]);
    const filesystem = {
      read: vi.fn(async (path: string) => {
        const body = files.get(path);
        if (!body) throw new Error('File not found');
        return body;
      }),
      write: vi.fn(async (path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
      }),
    };
    const resumeAssets = collection([oldAsset]);

    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({
      body: Buffer.from('%PDF-1.4 fresh\n'),
      filename: expect.any(String),
    });
    expect(filesystem.write).toHaveBeenCalledWith(
      PUBLISHED_RESUME_PDF_PATH,
      Buffer.from('%PDF-1.4 fresh\n'),
      { createParents: true },
    );
    expect(resumeAssets.records.at(-1)).toMatchObject({
      isPublished: true,
      status: 'published',
    });
  });

  it('does not regenerate when reading published storage fails unexpectedly', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => {
        throw new Error('object storage timeout');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toThrow('object storage timeout');

    expect(mocks.generateResumeArtifacts).not.toHaveBeenCalled();
    expect(resumeAssets.records).toHaveLength(1);
  });

  it('serves the PDF read during recovery publication without reading it again', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    let generatedPdfReads = 0;
    const filesystem = {
      read: vi.fn(async (path: string) => {
        if (path === 'generated-resumes/created-2/resume.pdf') {
          generatedPdfReads += 1;
          if (generatedPdfReads > 1) {
            throw new Error('object storage timeout');
          }
          return Buffer.from('%PDF-1.4 fresh\n');
        }
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', collection());

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({ body: Buffer.from('%PDF-1.4 fresh\n') });

    expect(generatedPdfReads).toBe(1);
    expect(resumeAssets.records.at(-1)).toMatchObject({
      isPublished: true,
      status: 'published',
    });
  });

  it('generates independently for concurrent filesystem contexts', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const makeFilesystem = (pdf: string) => {
      const files = new Map<string, Buffer>([
        ['generated-resumes/created-2/resume.pdf', Buffer.from(pdf)],
      ]);
      return {
        read: vi.fn(async (path: string) => {
          const body = files.get(path);
          if (!body) throw new Error('File not found');
          return body;
        }),
        write: vi.fn(async (path: string, body: Buffer) => {
          files.set(path, Buffer.from(body));
        }),
      };
    };
    const firstFilesystem = makeFilesystem('%PDF-1.4 first\n');
    const secondFilesystem = makeFilesystem('%PDF-1.4 second\n');
    const resumeAssets = collection([oldAsset]);

    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);

    await expect(
      Promise.all([
        ensurePublishedResumePdf(
          firstFilesystem as unknown as FilesystemInterface,
        ),
        ensurePublishedResumePdf(
          secondFilesystem as unknown as FilesystemInterface,
        ),
      ]),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: expect.any(String) }),
        expect.objectContaining({ filename: expect.any(String) }),
      ]),
    );

    // Each request keeps its own filesystem context. Once the shared asset is
    // published, the second request can serve its matching generated PDF
    // without overwriting its own published alias.
    expect(firstFilesystem.write).toHaveBeenCalledWith(
      PUBLISHED_RESUME_PDF_PATH,
      expect.any(Buffer),
      { createParents: true },
    );
    expect(secondFilesystem.read).toHaveBeenCalledWith(
      'generated-resumes/created-2/resume.pdf',
      { raw: true },
    );
  });

  it('renders recovery once when concurrent downloads share storage', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const files = new Map<string, Buffer>([
      [
        'generated-resumes/created-2/resume.pdf',
        Buffer.from('%PDF-1.4 fresh\n'),
      ],
    ]);
    const filesystem = {
      read: vi.fn(async (path: string) => {
        const body = files.get(path);
        if (!body) throw new Error('File not found');
        return body;
      }),
      write: vi.fn(async (path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
      }),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);

    await expect(
      Promise.all([
        ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
        ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
      ]),
    ).resolves.toHaveLength(2);

    expect(mocks.generateResumeArtifacts).toHaveBeenCalledOnce();
    expect(filesystem.write).toHaveBeenCalledTimes(1);
    expect(
      resumeAssets.records.filter((asset) => asset.isPublished),
    ).toHaveLength(1);
  });

  it('holds a session advisory lock through recovery rendering for a URL-scoped request database', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const files = new Map<string, Buffer>([
      [
        'generated-resumes/created-2/resume.pdf',
        Buffer.from('%PDF-1.4 fresh\n'),
      ],
    ]);
    const filesystem = {
      read: vi.fn(async (path: string) => {
        const body = files.get(path);
        if (!body) throw new Error('File not found');
        return body;
      }),
      write: vi.fn(async (path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
      }),
    };
    const query = vi.fn(async () => []);
    const session = {
      query,
      release: vi.fn(async () => {}),
    };
    mocks.resolveDatabase.mockResolvedValue({
      acquireSession: vi.fn(async () => session),
      url: 'postgresql://resume-test',
    });
    mocks.requestScopedDatabase.mockReturnValue(
      'postgresql://request-resume-test',
    );
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', collection([oldAsset]));
    mocks.collections.set('Application', collection());

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({ body: Buffer.from('%PDF-1.4 fresh\n') });

    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('statement_timeout', ?, false)",
      ['5min'],
    );
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_lock(hashtext(?))', [
      'iolaus:canonical-resume',
    ]);
    expect(session.release).toHaveBeenCalledTimes(2);
  });

  it('backs off public recovery after a renderer failure', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => {
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.generateResumeArtifacts.mockRejectedValue(
      new Error('renderer unavailable'),
    );

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toThrow('renderer unavailable');
    const failedAsset = resumeAssets.records.at(-1);
    if (!failedAsset) throw new Error('Expected a failed recovery asset.');
    Object.assign(failedAsset, {
      generatedAt: new Date('2000-01-01T00:00:00.000Z'),
      updated_at: new Date(),
    });
    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toMatchObject({ status: 503 });

    expect(mocks.generateResumeArtifacts).toHaveBeenCalledOnce();
    expect(resumeAssets.records).toHaveLength(2);
    expect(resumeAssets.records.at(-1)).toMatchObject({
      notes:
        'Automatic published resume recovery failed before artifacts were saved.',
      sourcePath: 'public-resume-recovery',
      status: 'failed',
    });
  });

  it('serves the recovered asset when the compatibility alias refresh fails', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async (path: string) => {
        if (path === 'generated-resumes/created-2/resume.pdf') {
          return Buffer.from('%PDF-1.4 fresh\n');
        }
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {
        throw new Error('published storage unavailable');
      }),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', collection());

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({ body: Buffer.from('%PDF-1.4 fresh\n') });
    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({ body: Buffer.from('%PDF-1.4 fresh\n') });

    expect(mocks.generateResumeArtifacts).toHaveBeenCalledOnce();
    expect(resumeAssets.records.at(-1)).toMatchObject({
      sourcePath: 'public-resume-recovery',
      status: 'published',
    });
  });

  it('refreshes editable default application links after recovery', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const draftApplication = record({
      id: 'app-draft',
      resumeAssetId: 'legacy-current',
      resumeMode: 'default',
      status: 'draft',
    });
    const files = new Map<string, Buffer>([
      [
        'generated-resumes/created-2/resume.pdf',
        Buffer.from('%PDF-1.4 fresh\n'),
      ],
    ]);
    const filesystem = {
      read: vi.fn(async (path: string) => {
        const body = files.get(path);
        if (!body) throw new Error('File not found');
        return body;
      }),
      write: vi.fn(async (path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
      }),
    };
    const resumeAssets = collection([oldAsset]);

    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', collection([draftApplication]));

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).resolves.toMatchObject({ filename: expect.any(String) });

    await vi.waitFor(() => {
      expect(draftApplication.resumeAssetId).toBe('created-2');
    });
  });

  it('backs off recovery when the source fails before an asset can be saved', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => {
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.loadPublishedResumeSource.mockRejectedValue(
      new Error('resume source unavailable'),
    );

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toThrow('resume source unavailable');
    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toMatchObject({ status: 503 });

    expect(mocks.loadPublishedResumeSource).toHaveBeenCalledOnce();
    expect(resumeAssets.records).toHaveLength(1);
  });

  it('backs off recovery after a transient history lookup failure', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => {
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.shouldThrowResumeAssetList = true;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 120_000));
    try {
      await expect(
        ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
      ).rejects.toThrow('Resume history unavailable');
      await expect(
        ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      vi.useRealTimers();
    }

    expect(mocks.loadPublishedResumeSource).not.toHaveBeenCalled();
    expect(resumeAssets.records).toHaveLength(1);
  });

  it('backs off recovery when the publication lock cannot be acquired', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => {
        throw new Error('File not found');
      }),
      write: vi.fn(async () => {}),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.resolveDatabase.mockRejectedValueOnce(
      new Error('resume database unavailable'),
    );

    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toThrow('resume database unavailable');
    await expect(
      ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
    ).rejects.toMatchObject({ status: 503 });

    expect(mocks.generateResumeArtifacts).not.toHaveBeenCalled();
    expect(resumeAssets.records).toHaveLength(1);
  });

  it('serves a recovered asset when the final published-asset lookup fails', async () => {
    const oldAsset = record({
      id: 'legacy-current',
      isPublished: true,
      pdfPath: 'generated-resumes/legacy-current/resume.pdf',
      status: 'published',
    });
    const files = new Map<string, Buffer>([
      [
        'generated-resumes/created-2/resume.pdf',
        Buffer.from('%PDF-1.4 fresh\n'),
      ],
    ]);
    const filesystem = {
      read: vi.fn(async (path: string) => {
        const body = files.get(path);
        if (!body) throw new Error('File not found');
        return body;
      }),
      write: vi.fn(async (path: string, body: Buffer) => {
        files.set(path, Buffer.from(body));
      }),
    };
    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', collection());
    mocks.shouldThrowPublishedAsset = true;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 300_000));
    try {
      await expect(
        ensurePublishedResumePdf(filesystem as unknown as FilesystemInterface),
      ).resolves.toMatchObject({ body: Buffer.from('%PDF-1.4 fresh\n') });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('refreshPublishedCanonicalResumeAsset', () => {
  it('generates, publishes, and points editable default applications at the fresh canonical resume', async () => {
    const oldAsset = record({
      id: 'old-canonical',
      isPublished: true,
      pdfPath: 'generated-resumes/old/resume.pdf',
      status: 'published',
    });
    const draftApplication = record({
      id: 'app-draft',
      resumeAssetId: 'old-canonical',
      resumeMode: 'default',
      status: 'draft',
    });
    const reviewApplication = record({
      id: 'app-review',
      resumeAssetId: 'old-canonical',
      resumeMode: 'default',
      status: 'awaiting_user',
    });
    const approvedApplication = record({
      id: 'app-approved',
      resumeAssetId: 'old-canonical',
      resumeMode: 'default',
      status: 'approved',
    });
    const customApplication = record({
      id: 'app-custom',
      resumeAssetId: 'custom-resume',
      resumeMode: 'custom',
      status: 'draft',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 fresh\n')),
      write: vi.fn(async () => {}),
    };

    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set(
      'Application',
      collection([
        draftApplication,
        reviewApplication,
        approvedApplication,
        customApplication,
      ]),
    );

    const result = await refreshPublishedCanonicalResumeAsset({
      filesystem: filesystem as unknown as FilesystemInterface,
    });

    expect(result.asset).toMatchObject({
      id: 'created-2',
      isPublished: true,
      outputSlug: 'canonical',
      status: 'published',
    });
    expect(result.updatedApplications).toBe(2);
    expect(filesystem.write).toHaveBeenCalledWith(
      PUBLISHED_RESUME_PDF_PATH,
      Buffer.from('%PDF-1.4 fresh\n'),
      { createParents: true },
    );
    expect(oldAsset).toMatchObject({
      isPublished: false,
      status: 'generated',
    });
    expect(draftApplication.resumeAssetId).toBe('created-2');
    expect(reviewApplication.resumeAssetId).toBe('created-2');
    expect(approvedApplication.resumeAssetId).toBe('old-canonical');
    expect(customApplication.resumeAssetId).toBe('custom-resume');
  });

  it('walks all application pages when repointing editable default applications', async () => {
    const oldAsset = record({
      id: 'old-canonical',
      isPublished: true,
      pdfPath: 'generated-resumes/old/resume.pdf',
      status: 'published',
    });
    const applications = Array.from({ length: 501 }, (_, index) =>
      record({
        id: `app-${index + 1}`,
        resumeAssetId: 'old-canonical',
        resumeMode: 'default',
        status: 'draft',
      }),
    );
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 fresh\n')),
      write: vi.fn(async () => {}),
    };
    const applicationCollection = collection(applications);

    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', applicationCollection);

    const result = await refreshPublishedCanonicalResumeAsset({
      filesystem: filesystem as unknown as FilesystemInterface,
    });

    expect(result.updatedApplications).toBe(501);
    expect(applicationCollection.list).toHaveBeenCalledWith({
      limit: 500,
      offset: 0,
    });
    expect(applicationCollection.list).toHaveBeenCalledWith({
      limit: 500,
      offset: 500,
    });
    expect(
      applications.every((item) => item.resumeAssetId === 'created-2'),
    ).toBe(true);
  });

  it('does not overwrite the published PDF when canonical generation fails', async () => {
    const oldAsset = record({
      id: 'old-canonical',
      isPublished: true,
      pdfPath: 'generated-resumes/old/resume.pdf',
      status: 'published',
    });
    const filesystem = {
      read: vi.fn(async () => Buffer.from('%PDF-1.4 old\n')),
      write: vi.fn(async () => {}),
    };

    const resumeAssets = collection([oldAsset]);
    mocks.collections.set('ResumeTailoringConfig', collection());
    mocks.collections.set('ResumeAsset', resumeAssets);
    mocks.collections.set('Application', collection());
    mocks.generateResumeArtifacts.mockRejectedValueOnce(
      new Error('renderer unavailable'),
    );

    await expect(
      refreshPublishedCanonicalResumeAsset({
        filesystem: filesystem as unknown as FilesystemInterface,
      }),
    ).rejects.toThrow('renderer unavailable');

    expect(filesystem.write).not.toHaveBeenCalled();
    expect(resumeAssets.records.at(-1)).toMatchObject({
      notes: 'Resume generation failed before artifacts were saved.',
      status: 'failed',
    });
    expect(oldAsset).toMatchObject({
      isPublished: true,
      status: 'published',
    });
  });
});
