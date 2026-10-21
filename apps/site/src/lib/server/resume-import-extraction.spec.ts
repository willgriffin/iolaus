import { createServer } from 'node:http';
import { PaddleOCRClient } from '@happyvertical/pdf';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  meter: vi.fn(
    async (options: {
      feature: string;
      invoke: () => Promise<{ result: unknown }>;
      maxOutputTokens: number;
    }) => (await options.invoke()).result,
  ),
}));
const meter = mocks.meter;
vi.mock('./ai-usage-guard.js', () => ({ meterAiWritingCall: mocks.meter }));

import {
  __resumeImportExtractionTest,
  interpretResumeImportText,
  ResumeImportExtractionError,
} from './resume-import-extraction.js';

const fictionalSource =
  '[Page 1]\nNorthwind Labs\n[Page 2]\nExample University';
const sectionData = {
  index: {
    complete: true,
    data: {
      blocks: [
        {
          kind: 'role',
          experienceId: 'experience-1',
          company: 'Northwind',
          title: 'Engineer',
          startLine: 1,
        },
        { kind: 'global', startLine: 2 },
      ],
    },
  },
  role: {
    complete: true,
    data: {
      company: 'Northwind',
      title: 'Engineer',
      skillEvidence: [
        {
          name: 'TypeScript',
          usage: 'Northwind Labs',
          depth: 'mentioned',
          sourceLine: 1,
        },
        {
          name: 'TypeScript',
          usage: 'Northwind Labs',
          depth: 'mentioned',
          sourceLine: 1,
        },
      ],
    },
  },
  other: {
    complete: true,
    data: {
      education: [
        { title: 'BSc', institution: 'Example University', pages: [2] },
      ],
      skills: [{ name: 'TypeScript', pages: [2] }],
    },
  },
};

function profile(
  reply: (section: keyof typeof sectionData) => unknown | Promise<unknown>,
): any {
  return {
    provider: 'bifrost' as const,
    profile: 'test',
    model: 'openai/test',
    maxOutputTokens: 16_384,
    timeout: 200_000,
    aiClient: {
      chat: vi.fn(
        async (
          messages: Array<{ content: string }>,
          options: Record<string, unknown>,
        ) => {
          const source = messages[0]?.content ?? '';
          const section = source.includes('SOURCE LINES:')
            ? 'index'
            : source.includes('VALIDATED GLOBAL LINES:')
              ? 'other'
              : 'role';
          return {
            content: JSON.stringify(await reply(section)),
            finishReason: 'stop',
            usage: {},
            toolCalls: [],
            options,
          };
        },
      ),
    },
  };
}

const valid = JSON.stringify({
  experiences: [
    {
      company: 'Northwind',
      title: 'Engineer',
      startDate: '2022-03',
      pages: [1],
    },
  ],
  education: [],
  skills: [{ name: 'TypeScript', pages: [1] }],
});

describe('resume import extraction output boundary', () => {
  it('indexes once then meters and authorizes only validated role and global calls', async () => {
    meter.mockClear();
    const client = profile((section) => sectionData[section]);
    const authorize = vi.fn(async () => {});
    const result = await interpretResumeImportText({
      authorize,
      pages: 2,
      profile: client,
      source: fictionalSource,
      subject: { tenantId: 'tenant', userId: 'user' },
    });
    expect(result).toMatchObject({
      experiences: [{ company: 'Northwind' }],
      education: [{ institution: 'Example University' }],
      skills: [{ name: 'TypeScript' }],
    });
    expect(meter).toHaveBeenCalledTimes(3);
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(client.aiClient.chat).toHaveBeenCalledTimes(3);
    for (const [messages, options] of client.aiClient.chat.mock.calls) {
      const source = messages[0]?.content ?? '';
      expect(options).toMatchObject({
        maxTokens: source.includes('VALIDATED ROLE LINES:') ? 8_192 : 4_096,
        timeout: 105_000,
        toolChoice: 'none',
        responseFormat: {
          type: 'json_schema',
          json_schema: {
            name: expect.stringMatching(/^resume_import_/u),
            strict: true,
          },
        },
      });
    }
    expect(
      meter.mock.calls
        .map(([options]) => ({
          feature: options.feature,
          maxOutputTokens: options.maxOutputTokens,
        }))
        .sort((left, right) => left.feature.localeCompare(right.feature)),
    ).toEqual([
      { feature: 'resume-import:index', maxOutputTokens: 4_096 },
      { feature: 'resume-import:other', maxOutputTokens: 4_096 },
      { feature: 'resume-import:role:experience-1', maxOutputTokens: 8_192 },
    ]);
  });

  it('uses an OpenAI-strict nullable wire schema while retaining required facts', () => {
    const schema = __resumeImportExtractionTest.resumeImportResponseSchema;
    const properties = schema.properties as Record<string, unknown>;
    const data = properties.data as Record<string, unknown>;
    const dataProperties = data.properties as Record<string, unknown>;
    const experiences = dataProperties.experiences as Record<string, unknown>;
    const experience = experiences.items as Record<string, unknown>;
    const experienceProperties = experience.properties as Record<
      string,
      unknown
    >;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['complete', 'data']);
    expect(properties.complete).toEqual({ type: 'boolean' });
    expect(data.additionalProperties).toBe(false);
    expect(data.required).toContain('profile');
    expect(experience.required).toEqual(
      expect.arrayContaining(['company', 'title', 'pages']),
    );
    expect(experienceProperties.company).toMatchObject({ type: 'string' });
    expect(experienceProperties.startDate).toMatchObject({
      type: expect.arrayContaining(['string', 'null']),
    });
    expect(JSON.stringify(schema)).not.toContain('"format":"uri"');
  });

  it('lets the provider declare incomplete role work on the wire, then rejects it at the server boundary', () => {
    const schema = __resumeImportExtractionTest.providerEnvelopeSchema(
      __resumeImportExtractionTest.roleEnvelope,
    );
    expect((schema.properties as Record<string, unknown>).complete).toEqual({
      type: 'boolean',
    });
    expect(() =>
      __resumeImportExtractionTest.parseEnvelope(
        __resumeImportExtractionTest.roleEnvelope,
        JSON.stringify({ complete: false, data: {} }),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it('reports the bounded call feature when a provider output reaches its limit', async () => {
    const client = profile(() => sectionData.index);
    client.aiClient.chat.mockResolvedValue({
      content: '{}',
      finishReason: 'length',
      usage: {},
      toolCalls: [],
    });
    await expect(
      interpretResumeImportText({
        authorize: async () => {},
        pages: 2,
        profile: client,
        source: fictionalSource,
        subject: { tenantId: 'tenant', userId: 'user' },
      }),
    ).rejects.toMatchObject({
      category: 'model_output_limit',
      diagnostic: 'provider_length:feature=index:length=2',
    });
  });

  it('derives the exact non-role complement from non-overlapping role spans', () => {
    const lines = __resumeImportExtractionTest.indexedSourceLines(
      ['[Page 1]', 'Profile', 'Northwind', 'Engineer', 'Education'].join('\n'),
    );
    const index = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleIndexEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          blocks: [
            { kind: 'global', startLine: 1 },
            {
              kind: 'role',
              experienceId: 'experience-1',
              company: 'Northwind',
              title: 'Engineer',
              startLine: 2,
            },
            { kind: 'global', startLine: 4 },
          ],
        },
      }),
    );
    expect(
      __resumeImportExtractionTest.validateRoleIndex(index, lines),
    ).toEqual({
      roles: [
        {
          experienceId: 'experience-1',
          company: 'Northwind',
          title: 'Engineer',
          spans: [{ startLine: 2, endLine: 3 }],
        },
      ],
      global: {
        spans: [
          { startLine: 1, endLine: 1 },
          { startLine: 4, endLine: 4 },
        ],
      },
    });
  });

  it('keeps the role/global block union in the strict provider schema', () => {
    const schema = __resumeImportExtractionTest.providerEnvelopeSchema(
      __resumeImportExtractionTest.roleIndexEnvelope,
    );
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('"blocks"');
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).not.toContain('"discriminator"');
    const data = (schema.properties as Record<string, Record<string, unknown>>)
      .data;
    const blocks = data?.properties as Record<string, Record<string, unknown>>;
    const items = blocks.blocks?.items as Record<string, unknown>;
    expect(items.anyOf).toEqual([
      expect.objectContaining({
        additionalProperties: false,
        properties: expect.objectContaining({
          kind: expect.objectContaining({ const: 'role' }),
        }),
      }),
      expect.objectContaining({
        additionalProperties: false,
        properties: expect.objectContaining({
          kind: expect.objectContaining({ const: 'global' }),
        }),
      }),
    ]);
    expect(serialized).toContain('"additionalProperties":false');
  });

  it('rejects malformed block anchors and provider schemas that still use role spans', () => {
    const lines = __resumeImportExtractionTest.indexedSourceLines(
      '[Page 1]\nNorthwind\nEngineer\nExample University',
    );
    const duplicate = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleIndexEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          blocks: [
            {
              kind: 'role',
              experienceId: 'experience-1',
              company: 'Northwind',
              title: 'Engineer',
              startLine: 1,
            },
            {
              kind: 'role',
              experienceId: 'experience-2',
              company: 'Example',
              title: 'Teacher',
              startLine: 1,
            },
          ],
        },
      }),
    );
    try {
      __resumeImportExtractionTest.validateRoleIndex(duplicate, lines);
      throw new Error('Expected duplicate block anchor to fail.');
    } catch (cause) {
      expect(cause).toMatchObject({
        category: 'malformed_output',
        diagnostic: 'schema:block_order',
      });
    }
    expect(() =>
      __resumeImportExtractionTest.parseEnvelope(
        __resumeImportExtractionTest.roleIndexEnvelope,
        JSON.stringify({
          complete: true,
          data: { blocks: [{ kind: 'role', startLine: 1, spans: [] }] },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it.each([
    [
      'an out-of-bounds start',
      [
        { kind: 'global', startLine: 1 },
        { kind: 'global', startLine: 4 },
      ],
      'schema:block_bounds',
    ],
    [
      'a nonmonotonic start',
      [
        { kind: 'global', startLine: 1 },
        {
          kind: 'role',
          experienceId: 'experience-1',
          company: 'Northwind',
          title: 'Engineer',
          startLine: 3,
        },
        { kind: 'global', startLine: 2 },
      ],
      'schema:block_order',
    ],
  ])('rejects %s without assigning lines to another block', (_label, blocks, diagnostic) => {
    const value = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleIndexEnvelope,
      JSON.stringify({ complete: true, data: { blocks } }),
    );
    expect(() =>
      __resumeImportExtractionTest.validateRoleIndex(
        value,
        __resumeImportExtractionTest.indexedSourceLines(
          '[Page 1]\nNorthwind\nEngineer\nFooter',
        ),
      ),
    ).toThrow(expect.objectContaining({ diagnostic }));
  });

  it('rejects 31 valid role anchors before scheduling role model calls', () => {
    const blocks = Array.from({ length: 31 }, (_, index) => ({
      kind: 'role' as const,
      experienceId: `experience-${index + 1}`,
      company: `Company ${index + 1}`,
      title: 'Engineer',
      startLine: index + 1,
    }));
    const value = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleIndexEnvelope,
      JSON.stringify({ complete: true, data: { blocks } }),
    );
    expect(() =>
      __resumeImportExtractionTest.validateRoleIndex(
        value,
        __resumeImportExtractionTest.indexedSourceLines(
          `[Page 1]\n${Array.from({ length: 31 }, () => 'Role').join('\n')}`,
        ),
      ),
    ).toThrow(expect.objectContaining({ diagnostic: 'schema:role_count' }));
  });

  it('rejects role or domain experience leaked through the global response schema', () => {
    expect(() =>
      __resumeImportExtractionTest.parseEnvelope(
        __resumeImportExtractionTest.otherEnvelope,
        JSON.stringify({
          complete: true,
          data: {
            education: [],
            skills: [],
            profile: null,
            experiences: [{ company: 'Northwind', title: 'Engineer' }],
          },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
    expect(
      __resumeImportExtractionTest.otherPrompt('L1|P1|Example University'),
    ).toContain(
      'Do not turn a role or domain label into an education, skill, or profile fact.',
    );
    expect(
      __resumeImportExtractionTest.otherPrompt('L1|P1|Example University'),
    ).toContain(
      'Education requires both an explicit credential title and an explicit institution in these source lines; omit an entry when either is unknown, never infer an issuer or use null for either required field.',
    );
  });

  it('requires source-ordered block anchors and keeps internal headings inside roles', () => {
    const prompt = __resumeImportExtractionTest.indexPrompt(
      __resumeImportExtractionTest.indexedSourceLines('[Page 1]\nNorthwind'),
    );
    expect(prompt).toContain("returning only each block's startLine");
    expect(prompt).toContain('The first block must start at line 1');
    expect(prompt).toContain(
      'Generic internal headings and projects remain inside their role block, never global blocks.',
    );
    expect(prompt).toContain('Start a new block at the heading line itself');
    expect(prompt).toContain('return complete:false');
    const missingFirst = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleIndexEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          blocks: [
            {
              kind: 'role',
              experienceId: 'experience-1',
              company: 'Northwind',
              title: 'Engineer',
              startLine: 2,
            },
          ],
        },
      }),
    );
    expect(() =>
      __resumeImportExtractionTest.validateRoleIndex(
        missingFirst,
        __resumeImportExtractionTest.indexedSourceLines(
          '[Page 1]\nNorthwind\nEngineer',
        ),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it('keeps markerless heading prose as duty-section bullets, retains genuine projects, and aggregates quoted role skill evidence', async () => {
    const source = [
      '[Page 1]',
      'Northwind',
      'Engineer',
      'Platform Architecture',
      'Built TypeScript services.',
      'Project Aurora',
      'Built the Aurora portal with TypeScript and PostgreSQL.',
      'Delivered a second Aurora result.',
      'Used PostgreSQL during 2021 to reconcile inventory counts.',
      '[Page 2]',
      'Example University',
      'TypeScript, PostgreSQL',
    ].join('\n');
    const client = profile((section) => {
      if (section === 'index')
        return {
          complete: true,
          data: {
            blocks: [
              {
                kind: 'role',
                experienceId: 'experience-1',
                company: 'Northwind',
                title: 'Engineer',
                startLine: 1,
              },
              { kind: 'global', startLine: 9 },
            ],
          },
        };
      if (section === 'role')
        return {
          complete: true,
          data: {
            company: 'Northwind',
            title: 'Engineer',
            bulletSections: [
              {
                title: 'Platform Architecture',
                bullets: ['Built TypeScript services.'],
              },
            ],
            projects: [
              {
                name: 'Project Aurora',
                bullets: [
                  'Built the Aurora portal with TypeScript and PostgreSQL.',
                  'Delivered a second Aurora result.',
                  'Used PostgreSQL during 2021 to reconcile inventory counts.',
                ],
                pages: [1],
              },
            ],
            skillEvidence: [
              {
                name: 'TypeScript',
                usage: 'Built services.',
                depth: 'hands_on',
                sourceLine: 4,
              },
              {
                name: 'PostgreSQL',
                usage: 'Built Aurora portal.',
                depth: 'hands_on',
                sourceLine: 6,
              },
              {
                name: 'PostgreSQL',
                usage: 'Reconciled inventory counts.',
                depth: 'hands_on',
                sourceLine: 8,
                startDate: '2021',
              },
            ],
          },
        };
      return {
        complete: true,
        data: {
          education: [
            { title: 'BSc', institution: 'Example University', pages: [2] },
          ],
          skills: [
            { name: 'TypeScript', pages: [2] },
            { name: 'PostgreSQL', pages: [2] },
          ],
        },
      };
    });
    const proposal = await interpretResumeImportText({
      authorize: async () => {},
      pages: 2,
      profile: client,
      source,
      subject: { tenantId: 'tenant', userId: 'user' },
    });
    const entries = __resumeImportExtractionTest.toEntries(proposal, source, 2);
    const experience = entries.find((entry) => entry.kind === 'experience');
    const project = entries.find((entry) => entry.kind === 'project');
    const skill = entries.find((entry) => entry.kind === 'skill');
    expect(experience?.fields.bulletSections).toBe(
      JSON.stringify([
        {
          title: 'Platform Architecture',
          bullets: ['Built TypeScript services.'],
        },
      ]),
    );
    expect(project?.fields.name).toBe('Project Aurora');
    expect(project?.fields.bullets).toBe(
      'Built the Aurora portal with TypeScript and PostgreSQL.\nDelivered a second Aurora result.\nUsed PostgreSQL during 2021 to reconcile inventory counts.',
    );
    expect(JSON.parse(skill?.fields.skillEvidence ?? '[]')).toEqual([
      expect.objectContaining({
        proposalExperienceId: 'experience-1',
        quote: 'Built TypeScript services.',
      }),
    ]);
    const postgresql = entries.find(
      (entry) => entry.kind === 'skill' && entry.fields.name === 'PostgreSQL',
    );
    if (!postgresql || postgresql.kind !== 'skill')
      throw new Error('Expected PostgreSQL skill');
    expect(JSON.parse(postgresql.fields.skillEvidence ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalExperienceId: 'experience-1',
          quote: 'Built the Aurora portal with TypeScript and PostgreSQL.',
        }),
        expect.objectContaining({
          proposalExperienceId: 'experience-1',
          quote: 'Used PostgreSQL during 2021 to reconcile inventory counts.',
          startDate: '2021',
        }),
      ]),
    );
    expect(experience?.evidence).toEqual(
      expect.arrayContaining([
        {
          page: 1,
          text: expect.stringContaining('Built TypeScript services.'),
        },
      ]),
    );
  });

  it('promotes only literal URL heading sections to projects and gives duplicate generic headings one bullet owner', async () => {
    const source = [
      '[Page 1]',
      'Northwind',
      'Engineer',
      'Platform Architecture',
      'Built platform outcome.',
      's-m-r-t.dev https://s-m-r-t.dev',
      'Built project outcome.',
      'Operated product platform.',
      'Server Cluster',
      'Built cluster subsystem.',
      'Maintained cluster operations.',
      'Distinct Initiative',
      'Delivered a native integration.',
      '[Page 2]',
      'Example University',
    ].join('\n');
    const client = profile((section) => {
      if (section === 'index')
        return {
          complete: true,
          data: {
            blocks: [
              {
                kind: 'role',
                experienceId: 'experience-1',
                company: 'Northwind',
                title: 'Engineer',
                startLine: 1,
              },
              { kind: 'global', startLine: 13 },
            ],
          },
        };
      if (section === 'role')
        return {
          complete: true,
          data: {
            company: 'Northwind',
            title: 'Engineer',
            bulletSections: [
              {
                title: 'Platform Architecture',
                bullets: ['Built platform outcome.'],
              },
              {
                title: 's-m-r-t.dev',
                bullets: ['Built project outcome.'],
              },
              {
                title: 'Server Cluster',
                bullets: ['Built cluster subsystem.'],
              },
            ],
            projects: [
              {
                name: 's-m-r-t.dev',
                summary: 'Source-grounded product work.',
                bullets: ['Operated product platform.'],
                startDate: '2021',
                endDate: '2022',
                pages: [1],
              },
              {
                name: 'Server Cluster',
                bullets: ['Maintained cluster operations.'],
                pages: [1],
              },
              {
                name: 'Distinct Initiative',
                summary: 'A separate named initiative.',
                bullets: ['Delivered a native integration.'],
                startDate: '2023',
                endDate: '2024',
                pages: [1],
              },
            ],
          },
        };
      return {
        complete: true,
        data: {
          education: [
            { title: 'BSc', institution: 'Example University', pages: [2] },
          ],
          skills: [],
        },
      };
    });
    const proposal = await interpretResumeImportText({
      authorize: async () => {},
      pages: 2,
      profile: client,
      source,
      subject: { tenantId: 'tenant', userId: 'user' },
    });
    const entries = __resumeImportExtractionTest.toEntries(proposal, source, 2);
    const experience = entries.find((entry) => entry.kind === 'experience');
    const projects = entries.filter((entry) => entry.kind === 'project');
    expect(experience?.fields.bulletSections).toBe(
      JSON.stringify([
        {
          title: 'Platform Architecture',
          bullets: ['Built platform outcome.'],
        },
        {
          title: 'Server Cluster',
          bullets: [
            'Built cluster subsystem.',
            'Maintained cluster operations.',
          ],
        },
      ]),
    );
    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      kind: 'project',
      fields: {
        name: 's-m-r-t.dev',
        url: 'https://s-m-r-t.dev',
        summary: 'Source-grounded product work.',
        bullets: 'Built project outcome.\nOperated product platform.',
        startDate: '2021',
        endDate: '2022',
      },
      evidence: [{ page: 1, text: expect.stringContaining('s-m-r-t.dev') }],
    });
    expect(projects[1]).toMatchObject({
      kind: 'project',
      fields: {
        name: 'Distinct Initiative',
        summary: 'A separate named initiative.',
        bullets: 'Delivered a native integration.',
        startDate: '2023',
        endDate: '2024',
      },
    });
  });

  it('fails closed when a generic section/project collision would discard project dates', () => {
    const output = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          company: 'Northwind',
          title: 'Engineer',
          bulletSections: [
            { title: 'Delivery', bullets: ['Delivered a platform.'] },
          ],
          projects: [
            {
              name: 'Delivery',
              bullets: ['Maintained the platform.'],
              startDate: '2022',
              pages: [1],
            },
          ],
        },
      }),
    );
    try {
      __resumeImportExtractionTest.validateRoleOutput(
        {
          experienceId: 'experience-1',
          company: 'Northwind',
          title: 'Engineer',
          spans: [{ startLine: 1, endLine: 4 }],
        },
        output.data,
        __resumeImportExtractionTest.indexedSourceLines(
          '[Page 1]\nNorthwind\nEngineer\nDelivery\nDelivered a platform.',
        ),
      );
      throw new Error('Expected an ambiguous section/project collision');
    } catch (error) {
      expect(error).toMatchObject({
        category: 'malformed_output',
        diagnostic: 'schema:ambiguous_project_section',
      });
    }
  });

  it('promotes a repeated literal URL heading once and keeps the first heading citation', () => {
    const output = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          company: 'Northwind',
          title: 'Engineer',
          bulletSections: [{ title: 'Product', bullets: ['Built product.'] }],
        },
      }),
    );
    const result = __resumeImportExtractionTest.validateRoleOutput(
      {
        experienceId: 'experience-1',
        company: 'Northwind',
        title: 'Engineer',
        spans: [{ startLine: 1, endLine: 5 }],
      },
      output.data,
      __resumeImportExtractionTest.indexedSourceLines(
        [
          '[Page 1]',
          'Northwind',
          'Engineer',
          'Product https://example.test/product',
          '[Page 2]',
          'Product https://example.test/product',
          'Built product.',
        ].join('\n'),
      ),
    );
    expect(result).not.toHaveProperty('bulletSections');
    expect(result.projects).toEqual([
      {
        name: 'Product',
        url: 'https://example.test/product',
        bullets: ['Built product.'],
        pages: [1, 2],
      },
    ]);
  });

  it('requires every explicit role and project skill observation and preserves project bullet ownership', () => {
    const prompt = __resumeImportExtractionTest.rolePrompt(
      {
        experienceId: 'experience-1',
        company: 'Fictional Company',
        title: 'Engineer',
        spans: [{ startLine: 1, endLine: 4 }],
      },
      [
        'L1|P1|Fictional Project',
        'L2|P1|Built with TypeScript and PostgreSQL.',
        'L3|P1|Delivered a second project result.',
        'L4|P1|Team Leadership',
      ].join('\n'),
    );
    expect(prompt).toContain(
      'Emit a skillEvidence observation for every distinct skill explicitly named in role or nested-project prose or bullets.',
    );
    expect(prompt).toContain(
      'the strongest exact L<number> source line that names that skill or a standard alias and describes its use, never a company, title, or role-date header.',
    );
    expect(prompt).toContain(
      'The server derives the quote and page, so never copy either into this response.',
    );
    expect(prompt).toContain(
      'usage must be a concise phrase of at most 240 characters, never a repeated full bullet.',
    );
    expect(prompt).toContain(
      'If one source line names multiple skills, emit one observation for each distinct skill and reuse that sourceLine;',
    );
    expect(prompt).toContain(
      'Assign each bullet to the immediately preceding labeled section or named project and keep it there until the next peer heading;',
    );
    expect(prompt).toContain(
      'never move a project bullet into unsectioned role bullets.',
    );
    expect(prompt).toContain(
      'Treat a generic functional heading as a bullet section whenever it could be a responsibility category.',
    );
    expect(prompt).toContain(
      'A project must be a clearly identified distinct named product, client deliverable, or initiative.',
    );
    expect(prompt).toContain(
      'A standalone named heading with a literal HTTP(S) or repository URL is a project heading:',
    );
    expect(prompt).toContain(
      'Never emit one heading in both bulletSections and projects.',
    );
    expect(prompt).toContain(
      'After a labeled responsibility/category heading, preserve every following achievement paragraph as a bullet in that section even when it has no bullet glyph.',
    );
    expect(prompt).toContain(
      'Only introductory role prose before the first labeled section may be a summary.',
    );
    expect(prompt).toContain(
      'Preserve a distinct observation for each explicitly dated use of a skill, even when the same skill has another undated observation;',
    );
  });

  it('fails the entire proposal when a role output is incomplete or invokes a tool', async () => {
    for (const variant of ['incomplete', 'tool'] as const) {
      const client = profile((section) =>
        section === 'role'
          ? { ...sectionData.role, complete: false }
          : sectionData[section],
      );
      if (variant === 'tool')
        client.aiClient.chat.mockImplementation(
          async (messages: Array<{ content: string }>) => ({
            content: JSON.stringify(sectionData.role),
            finishReason: 'stop',
            usage: {},
            toolCalls: messages[0]?.content.includes('VALIDATED ROLE')
              ? [{}]
              : [],
          }),
        );
      await expect(
        interpretResumeImportText({
          authorize: async () => {},
          pages: 2,
          profile: client,
          source: fictionalSource,
          subject: { tenantId: 'tenant', userId: 'user' },
        }),
      ).rejects.toMatchObject({ category: 'malformed_output' });
    }
  });

  it('rejects a skill source line outside its role span before entries are returned', async () => {
    const client = profile((section) =>
      section === 'role'
        ? {
            ...sectionData.role,
            data: {
              ...sectionData.role.data,
              skillEvidence: [
                { ...sectionData.role.data.skillEvidence[0], sourceLine: 2 },
              ],
            },
          }
        : sectionData[section],
    );
    await expect(
      interpretResumeImportText({
        authorize: async () => {},
        pages: 2,
        profile: client,
        source: fictionalSource,
        subject: { tenantId: 'tenant', userId: 'user' },
      }),
    ).rejects.toMatchObject({
      category: 'malformed_output',
      diagnostic: 'schema:unsupported_skill_evidence',
    });
  });

  it('grounds evidence to controlled aliases, preserves explicit usage dates, and removes unsupported facts', () => {
    const output = __resumeImportExtractionTest.parseEnvelope(
      __resumeImportExtractionTest.roleEnvelope,
      JSON.stringify({
        complete: true,
        data: {
          company: 'Northwind',
          title: 'PostgreSQL Engineer',
          skillEvidence: [
            {
              name: 'Postgres',
              usage: 'Used the database.',
              depth: 'hands_on',
              sourceLine: 3,
              startDate: '2021',
            },
            {
              name: 'Postgres',
              usage: 'Role header mention.',
              depth: 'mentioned',
              sourceLine: 2,
              startDate: '2019',
            },
            {
              name: 'C',
              usage: 'Incorrectly inferred from C++.',
              depth: 'mentioned',
              sourceLine: 4,
            },
            {
              name: 'C++',
              usage: 'Built bindings.',
              depth: 'hands_on',
              sourceLine: 4,
            },
            {
              name: 'TypeScript',
              usage: 'Unsupported skill.',
              depth: 'mentioned',
              sourceLine: 3,
            },
          ],
        },
      }),
    );
    const result = __resumeImportExtractionTest.validateRoleOutput(
      {
        experienceId: 'experience-1',
        company: 'Northwind',
        title: 'PostgreSQL Engineer',
        spans: [{ startLine: 1, endLine: 4 }],
      },
      output.data,
      __resumeImportExtractionTest.indexedSourceLines(
        [
          '[Page 1]',
          'Northwind',
          'PostgreSQL Engineer 2019',
          'Used PostgreSQL in 2021.',
          'Built C++ bindings.',
        ].join('\n'),
      ),
    );
    expect(result.skillEvidence).toEqual([
      expect.objectContaining({
        name: 'Postgres',
        quote: 'Used PostgreSQL in 2021.',
        startDate: '2021',
      }),
      expect.objectContaining({
        name: 'Postgres',
        quote: 'PostgreSQL Engineer 2019',
      }),
      expect.objectContaining({ name: 'C++', quote: 'Built C++ bindings.' }),
    ]);
    expect(result.skillEvidence?.[1]).not.toHaveProperty('startDate');
    expect(result.skillEvidence).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'C' })]),
    );
    expect(result.skillEvidenceSanitized).toBe(true);
  });

  it('does not create a skill from an unsupported observation and reports one review warning', async () => {
    const source = [
      '[Page 1]',
      'Northwind',
      'Engineer',
      'Built PostgreSQL services.',
    ].join('\n');
    const client = profile((section) => {
      if (section === 'index')
        return {
          complete: true,
          data: {
            blocks: [
              {
                kind: 'role',
                experienceId: 'experience-1',
                company: 'Northwind',
                title: 'Engineer',
                startLine: 1,
              },
            ],
          },
        };
      return {
        complete: true,
        data: {
          company: 'Northwind',
          title: 'Engineer',
          skillEvidence: [
            {
              name: 'TypeScript',
              usage: 'Unsupported observation.',
              depth: 'mentioned',
              sourceLine: 3,
            },
          ],
        },
      };
    });
    const proposal = await interpretResumeImportText({
      authorize: async () => {},
      pages: 1,
      profile: client,
      source,
      subject: { tenantId: 'tenant', userId: 'user' },
    });
    expect(proposal.skills).toEqual([]);
    expect(proposal.extractionWarnings).toEqual([
      'Some unsupported skill observations or usage dates were omitted; verify skill evidence.',
    ]);
  });

  it('fails closed when a skill source line exceeds the preserved quote limit', async () => {
    const source = `[Page 1]\nNorthwind\n${'x'.repeat(1201)}`;
    const client = profile((section) => {
      if (section === 'index')
        return {
          complete: true,
          data: {
            blocks: [
              {
                kind: 'role',
                experienceId: 'experience-1',
                company: 'Northwind',
                title: 'Engineer',
                startLine: 1,
              },
            ],
          },
        };
      return section === 'role'
        ? {
            complete: true,
            data: {
              company: 'Northwind',
              title: 'Engineer',
              skillEvidence: [
                {
                  name: 'TypeScript',
                  usage: 'Built services.',
                  depth: 'hands_on',
                  sourceLine: 2,
                },
              ],
            },
          }
        : { complete: true, data: { education: [], skills: [] } };
    });
    await expect(
      interpretResumeImportText({
        authorize: async () => {},
        pages: 1,
        profile: client,
        source,
        subject: { tenantId: 'tenant', userId: 'user' },
      }),
    ).rejects.toMatchObject({
      category: 'malformed_output',
      diagnostic: 'schema:skill_evidence_line_too_long',
    });
  });

  it('requires nonempty citations on every section entry and profile', () => {
    const parse = (data: Record<string, unknown>) =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'skills',
        JSON.stringify({ complete: true, data }),
      );
    expect(() =>
      parse({
        experiences: [],
        education: [],
        skills: [{ name: 'TypeScript', pages: [] }],
      }),
    ).toThrow(ResumeImportExtractionError);
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'experience',
        JSON.stringify({
          complete: true,
          data: {
            experiences: [],
            education: [],
            skills: [],
            profile: { summary: 'Fictional summary.', pages: [] },
          },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it('keeps the experience prompt exemplar valid for the section parser', () => {
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'experience',
        JSON.stringify({
          complete: true,
          data: {
            experiences: [
              {
                company: 'Fictional Company',
                title: 'Engineer',
                startDate: '2020-01',
                endDate: '2021-12',
                summary: 'Introductory role summary.',
                bullets: ['Delivered a supported outcome.'],
                projects: [
                  {
                    name: 'Fictional Project',
                    url: 'https://example.invalid/project',
                    summary: 'Introductory project summary.',
                    bullets: ['Delivered a project outcome.'],
                    startDate: '2020-01',
                    endDate: '2021-12',
                    pages: [1],
                  },
                ],
                pages: [1],
              },
            ],
            education: [],
            skills: [],
            profile: { summary: 'Professional summary.', pages: [1] },
          },
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['null profile', null],
    ['null profile summary', { summary: null, pages: [1] }],
    ['blank profile summary', { summary: '  ', pages: [1] }],
  ])('omits a %s through the production section parser', (_label, profile) => {
    const result = __resumeImportExtractionTest.parseSectionModelJson(
      'experience',
      JSON.stringify({
        complete: true,
        data: { experiences: [], education: [], skills: [], profile },
      }),
    );
    expect(result).not.toHaveProperty('profile');
  });

  it('omits null optional dates through the production section parser', () => {
    const result = __resumeImportExtractionTest.parseSectionModelJson(
      'experience',
      JSON.stringify({
        complete: true,
        data: {
          experiences: [
            {
              company: 'Fictional Company',
              title: 'Engineer',
              startDate: null,
              endDate: null,
              projects: [
                {
                  name: 'Fictional Project',
                  startDate: null,
                  endDate: null,
                  pages: [1],
                },
              ],
              pages: [1],
            },
          ],
          education: [],
          skills: [],
        },
      }),
    );
    expect(result.experiences[0]).not.toHaveProperty('startDate');
    expect(result.experiences[0]).not.toHaveProperty('endDate');
    expect(result.experiences[0]?.projects?.[0]).not.toHaveProperty(
      'startDate',
    );
    expect(result.experiences[0]?.projects?.[0]).not.toHaveProperty('endDate');
  });

  it('rejects invalid non-null profile data and preserves cross-section checks', () => {
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'experience',
        JSON.stringify({
          complete: true,
          data: {
            experiences: [],
            education: [],
            skills: [],
            profile: { summary: 9, pages: [1] },
          },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'experience',
        JSON.stringify({
          complete: true,
          data: {
            experiences: [],
            education: [],
            skills: [{ name: 'TypeScript', pages: [1] }],
            profile: null,
          },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it('instructs bullet-only projects to preserve every source bullet without a summary', () => {
    const prompt = __resumeImportExtractionTest.sectionPrompt(
      'experience',
      '[Page 1]\nProject: Fictional Portal\n- Delivered a documented prototype.\n- Added automated checks.',
    );
    expect(prompt).toContain(
      'For every project source line explicitly formatted as a bullet, copy that line into the project bullets array, never its summary.',
    );
    expect(prompt).toContain('omit its summary, even when there is one bullet');
    expect(prompt).toContain(
      'Set profile to null unless the source contains explicit professional or profile summary text; never infer profile content from roles.',
    );
    expect(prompt).toContain('Use null only for absent optional values;');
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'experience',
        JSON.stringify({
          complete: true,
          data: {
            experiences: [
              {
                company: 'Fictional Company',
                title: 'Engineer',
                pages: [1],
                projects: [
                  {
                    name: 'Fictional Portal',
                    bullets: [
                      'Delivered a documented prototype.',
                      'Added automated checks.',
                    ],
                    pages: [1],
                  },
                ],
              },
            ],
            education: [],
            skills: [],
          },
        }),
      ),
    ).not.toThrow();
  });

  it('exposes only host-allowlisted structural failure categories', () => {
    const error = new ResumeImportExtractionError('limit');
    expect(error.category).toBe('limit');
    expect(error.message).toBe('limit');
  });
  it('accepts bounded JSON and preserves partial dates', () => {
    const value = __resumeImportExtractionTest.parseModelJson(valid);
    const entries = __resumeImportExtractionTest.toEntries(
      value,
      '[Page 1]\nCasey Example',
      1,
    );
    expect(entries[0]).toMatchObject({
      kind: 'experience',
      fields: { startDate: '2022-03' },
    });
    expect(entries[0]?.evidence).toEqual([{ page: 1, text: 'Casey Example' }]);
  });

  it('accepts a compact full fictional resume without dropping supported entries', () => {
    const value = __resumeImportExtractionTest.parseModelJson(
      JSON.stringify({
        experiences: Array.from({ length: 12 }, (_, index) => ({
          company: `Fictional Company ${index + 1}`,
          title: 'Senior Software Engineer',
          startDate: `${2012 + index}-01`,
          endDate: index === 0 ? null : `${2012 + index}-12`,
          summary:
            index === 1
              ? null
              : 'Built and operated a fictional candidate product.',
          bullets:
            index === 2
              ? null
              : [
                  'Delivered a reliable fictional service.',
                  'Mentored a fictional engineering team.',
                ],
          pages: [Math.min(4, Math.floor(index / 3) + 1)],
        })),
        education: Array.from({ length: 3 }, (_, index) => ({
          title: `Fictional Degree ${index + 1}`,
          institution: 'Fictional University',
          startDate: `${2000 + index}-09`,
          endDate: `${2004 + index}-05`,
          detail: index === 0 ? null : undefined,
          pages: [1],
        })),
        skills: Array.from({ length: 30 }, (_, index) => ({
          name: `Fictional Skill ${index + 1}`,
          pages: [Math.min(4, Math.floor(index / 8) + 1)],
        })),
        profile: null,
      }),
    );
    const entries = __resumeImportExtractionTest.toEntries(
      value,
      '[Page 1]\nFictional resume',
      4,
    );
    expect(entries).toHaveLength(45);
    expect(entries[0]?.fields).not.toHaveProperty('endDate');
    expect(entries[1]?.fields).not.toHaveProperty('summary');
    expect(entries[2]?.fields).not.toHaveProperty('bullets');
  });

  it('keeps bullet-only roles separate from introductory summaries', () => {
    const proposal = __resumeImportExtractionTest.parseModelJson(
      JSON.stringify({
        experiences: [
          {
            company: 'Northwind',
            title: 'Engineer',
            bullets: ['Built the service.', 'Mentored teammates.'],
            pages: [1],
          },
          {
            company: 'Example',
            title: 'Lead',
            summary: 'Led the platform team.',
            bullets: ['Reduced latency.'],
            pages: [1],
          },
        ],
        education: [],
        skills: [],
      }),
    );
    const entries = __resumeImportExtractionTest.toEntries(
      proposal,
      '[Page 1]\nFictional resume',
      1,
    );
    expect(entries[0].fields).not.toHaveProperty('summary');
    if (entries[0].kind !== 'experience')
      throw new Error('Expected experience');
    expect(entries[0].fields.bullets).toBe(
      'Built the service.\nMentored teammates.',
    );
    expect(entries[1].fields).toMatchObject({
      summary: 'Led the platform team.',
      bullets: 'Reduced latency.',
    });
  });

  it('accepts a long role bullet list but bounds total bullet text', () => {
    const candidate = (bullets: string[]) =>
      JSON.stringify({
        experiences: [
          { company: 'Northwind', title: 'Engineer', bullets, pages: [1] },
        ],
        education: [],
        skills: [],
      });
    expect(
      __resumeImportExtractionTest.parseModelJson(
        candidate(Array.from({ length: 40 }, (_, i) => `Achievement ${i}`)),
      ).experiences[0].bullets,
    ).toHaveLength(40);
    expect(() =>
      __resumeImportExtractionTest.parseModelJson(
        candidate(Array(101).fill('Item')),
      ),
    ).toThrow();
    expect(() =>
      __resumeImportExtractionTest.parseModelJson(
        candidate(Array(50).fill('a'.repeat(1100))),
      ),
    ).toThrow();
  });

  it('keeps project bullets only in their linked project section', () => {
    const value = __resumeImportExtractionTest.parseModelJson(
      JSON.stringify({
        experiences: [
          {
            company: 'Northwind',
            title: 'Founder',
            startDate: '2020',
            pages: [1],
            bullets: ['Led the company.'],
            projects: [
              {
                name: 'Example Portal',
                url: 'https://example.com',
                summary: 'A customer portal.',
                bullets: ['Built checkout.', 'Improved accessibility.'],
                pages: [1],
              },
            ],
          },
        ],
        education: [],
        skills: [],
      }),
    );
    const entries = __resumeImportExtractionTest.toEntries(
      value,
      '[Page 1]\nFictional source',
      1,
    );
    expect(entries.filter((entry) => entry.kind === 'experience')).toHaveLength(
      1,
    );
    if (entries[0].kind !== 'experience')
      throw new Error('Expected experience');
    expect(entries[0].fields.bullets).toBe('Led the company.');
    expect(entries[1]).toMatchObject({
      kind: 'project',
      fields: {
        name: 'Example Portal',
        url: 'https://example.com',
        proposalExperienceId: 'experience-1',
        summary: 'A customer portal.',
        bullets: 'Built checkout.\nImproved accessibility.',
      },
      evidence: [{ page: 1, text: 'Fictional source' }],
    });
  });

  it('rejects unsafe project URLs and tolerates absent optional project facts', () => {
    const candidate = (url: unknown) =>
      JSON.stringify({
        experiences: [
          {
            company: 'Northwind',
            title: 'Engineer',
            pages: [1],
            projects: [
              { name: 'Portal', url, summary: null, bullets: null, pages: [1] },
            ],
          },
        ],
        education: [],
        skills: [],
      });
    expect(
      __resumeImportExtractionTest.parseModelJson(candidate(null))
        .experiences[0].projects?.[0],
    ).not.toHaveProperty('url');
    expect(() =>
      __resumeImportExtractionTest.parseModelJson(
        candidate('javascript:alert(1)'),
      ),
    ).toThrow();
  });

  it('uses the client-supported output ceiling for complete resumes', () => {
    expect(__resumeImportExtractionTest.maxModelOutputTokens).toBe(4_096);
  });

  it('separates fictional experience, education, and skills outputs before merging', () => {
    const parse = (
      section: 'experience' | 'education' | 'skills',
      data: Record<string, unknown>,
    ) =>
      __resumeImportExtractionTest.parseSectionModelJson(
        section,
        JSON.stringify({ complete: true, data }),
      );
    const blank = { experiences: [], education: [], skills: [] };
    const merged = __resumeImportExtractionTest.mergeSections([
      parse('experience', {
        ...blank,
        experiences: [{ company: 'Northwind', title: 'Engineer', pages: [1] }],
      }),
      parse('education', {
        ...blank,
        education: [
          { title: 'BSc', institution: 'Example University', pages: [1] },
        ],
      }),
      parse('skills', {
        ...blank,
        skills: [
          { name: 'TypeScript', pages: [1] },
          { name: 'Svelte', pages: [1] },
        ],
      }),
    ]);
    expect(merged).toMatchObject({
      experiences: [{ company: 'Northwind' }],
      education: [{ title: 'BSc' }],
      skills: [{ name: 'TypeScript' }, { name: 'Svelte' }],
    });
  });

  it('rejects a section that claims another section or cannot declare completion', () => {
    const crossSection = JSON.stringify({
      complete: true,
      data: {
        experiences: [{ company: 'Northwind', title: 'Engineer', pages: [1] }],
        education: [],
        skills: [],
      },
    });
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'skills',
        crossSection,
      ),
    ).toThrow(ResumeImportExtractionError);
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        'skills',
        JSON.stringify({
          complete: false,
          data: { experiences: [], education: [], skills: [] },
        }),
      ),
    ).toThrow(ResumeImportExtractionError);
  });

  it.each([
    ['invalid JSON', '{'],
    [
      'unknown field',
      JSON.stringify({
        experiences: [],
        education: [],
        skills: [],
        surprise: true,
      }),
    ],
    [
      'malformed date',
      JSON.stringify({
        experiences: [
          {
            company: 'Northwind',
            title: 'Engineer',
            startDate: 'Spring 2022',
            pages: [1],
          },
        ],
        education: [],
        skills: [],
      }),
    ],
  ])('refuses %s', (_label, content) => {
    expect(() =>
      __resumeImportExtractionTest.parseModelJson(content),
    ).toThrow();
  });

  it('reports a content-free schema diagnostic for invalid optional values', () => {
    try {
      __resumeImportExtractionTest.parseModelJson(
        JSON.stringify({
          experiences: [
            {
              company: 'Northwind',
              title: 'Engineer',
              startDate: 'Spring 2022',
              pages: [1],
            },
          ],
          education: [],
          skills: [],
        }),
      );
      throw new Error('Expected parsing to fail.');
    } catch (cause) {
      expect(cause).toMatchObject({
        category: 'malformed_output',
        diagnostic: 'schema:experiences.0.startDate:invalid_format',
      });
    }
  });

  it('does not manufacture page evidence for out-of-range citations', () => {
    const value = __resumeImportExtractionTest.parseModelJson(
      JSON.stringify({
        experiences: [{ company: 'Northwind', title: 'Engineer', pages: [99] }],
        education: [],
        skills: [],
      }),
    );
    expect(
      __resumeImportExtractionTest.toEntries(
        value,
        '[Page 1]\nCasey Example',
        1,
      )[0]?.evidence,
    ).toEqual([]);
  });

  it('does not accept a whitespace-only page as citation evidence', () => {
    const value = __resumeImportExtractionTest.parseModelJson(
      JSON.stringify({
        experiences: [{ company: 'Northwind', title: 'Engineer', pages: [1] }],
        education: [],
        skills: [],
      }),
    );
    expect(
      __resumeImportExtractionTest.toEntries(value, '[Page 1]\n \t ', 1)[0]
        ?.evidence,
    ).toEqual([]);
  });

  it.each([
    'experience',
    'education',
    'skills',
  ] as const)('keeps the %s prompt exemplar valid for the section parser', (section) => {
    const prompt = __resumeImportExtractionTest.sectionPrompt(
      section,
      '[Page 1]\nFictional source',
    );
    const match = prompt.match(/exact exemplar: (\{.+\}) The schema requires/u);
    expect(match?.[1]).toBeDefined();
    expect(() =>
      __resumeImportExtractionTest.parseSectionModelJson(
        section,
        match?.[1] ?? '',
      ),
    ).not.toThrow();
  });

  it('preserves PaddleOCR source-page order for scanned-page evidence', () => {
    const result = __resumeImportExtractionTest.paddleText(
      [
        { pageNumber: 1, markdown: 'Casey Example', layout: {} },
        { pageNumber: 2, markdown: 'Northwind Labs', layout: {} },
      ],
      2,
    );
    expect(result.text).toBe(
      '[Page 1]\nCasey Example\n\n[Page 2]\nNorthwind Labs',
    );
  });

  it('routes flattened native pages to structured OCR while retaining line-structured native text', () => {
    expect(
      __resumeImportExtractionTest.needsStructuredOcr({
        pages: 2,
        text: `[Page 1]\n${'A'.repeat(400)}\n\n[Page 2]\nNorthwind`,
      }),
    ).toBe(true);
    expect(
      __resumeImportExtractionTest.needsStructuredOcr({
        pages: 1,
        text: `[Page 1]\nNorthwind\nEngineer\n${'A'.repeat(400)}`,
      }),
    ).toBe(false);
    expect(
      __resumeImportExtractionTest.needsStructuredOcr({
        pages: 1,
        needsOcr: true,
        text: '[Page 1]\nNorthwind',
      }),
    ).toBe(true);
  });

  it('retains an empty OCR page marker when another page has OCR text', () => {
    const result = __resumeImportExtractionTest.paddleText(
      [
        { pageNumber: 1, markdown: '', layout: {} },
        { pageNumber: 2, markdown: 'Northwind Labs', layout: {} },
      ],
      2,
    );
    expect(result.text).toBe('[Page 1]\n\n\n[Page 2]\nNorthwind Labs');
  });

  it('accepts blank page markdown through the real PaddleOCR HTTP response parser', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          errorCode: 0,
          result: {
            layoutParsingResults: [
              { markdown: { text: '' }, prunedResult: {} },
              { markdown: { text: 'Northwind Labs' }, prunedResult: {} },
            ],
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port');
    try {
      const result = await new PaddleOCRClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
      }).parse(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
      expect(result.pages.map((page) => page.markdown)).toEqual([
        '',
        'Northwind Labs',
      ]);
      expect(
        __resumeImportExtractionTest.paddleText(result.pages, 2).text,
      ).toBe('[Page 1]\n\n\n[Page 2]\nNorthwind Labs');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.each([
    [[{ pageNumber: 2, markdown: 'Wrong page', layout: {} }]],
    [[{ pageNumber: 1, markdown: '', layout: {} }]],
    [
      [
        {
          pageNumber: 1,
          markdown: 'Missing layout',
          layout: [] as unknown as Record<string, unknown>,
        },
      ],
    ],
  ])('fails closed for malformed PaddleOCR pages', (pages) => {
    expect(() => __resumeImportExtractionTest.paddleText(pages, 1)).toThrow(
      ResumeImportExtractionError,
    );
  });

  it('maps a PaddleOCR provider rejection to a bounded failure', async () => {
    await expect(
      __resumeImportExtractionTest.paddlePdfText(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        1,
        async () => {},
        undefined,
        {
          parse: async () => {
            throw new Error('private provider response');
          },
        },
      ),
    ).rejects.toMatchObject({ category: 'unavailable' });
  });

  it('honors an aborted OCR call without invoking the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      __resumeImportExtractionTest.paddlePdfText(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        1,
        async () => {},
        controller.signal,
        {
          parse: async () => {
            calls += 1;
            return { pages: [], markdown: '' };
          },
        },
      ),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(calls).toBe(0);
  });

  it('rejects a concurrent OCR request instead of retaining an unbounded queue', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      parse: async () => {
        await held;
        return {
          pages: [{ pageNumber: 1, markdown: 'Casey', layout: {} }],
          markdown: 'Casey',
        };
      },
    };
    const first = __resumeImportExtractionTest.paddlePdfText(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      1,
      async () => {},
      undefined,
      client,
    );
    await expect(
      __resumeImportExtractionTest.paddlePdfText(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        1,
        async () => {},
        undefined,
        client,
      ),
    ).rejects.toMatchObject({ category: 'unavailable' });
    release();
    await expect(first).resolves.toMatchObject({ ocr: true });
  });
});
