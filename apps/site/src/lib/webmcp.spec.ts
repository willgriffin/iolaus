import { readFileSync } from 'node:fs';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import {
  registerWebMcpTools,
  type WebMcpRegistrationDefinition,
} from '@happyvertical/smrt-web';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandCenterWebMcpConfig,
  jobSearchWebMcpToolDefinitions,
} from './webmcp';

const documentDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'document',
);

type RegisteredTool = {
  annotations?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
  name: string;
};

function installModelContext(registered: RegisteredTool[]) {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      modelContext: {
        async registerTool(tool: {
          annotations?: Record<string, unknown>;
          execute: (args: Record<string, unknown>) => Promise<string>;
          name: string;
        }) {
          registered.push(tool);
        },
      },
    },
  });
}

function isReadDefinition(
  definition: WebMcpRegistrationDefinition,
): definition is WebMcpRegistrationDefinition & { effect: 'read' } {
  return 'effect' in definition && definition.effect === 'read';
}

afterEach(() => {
  if (documentDescriptor) {
    Object.defineProperty(globalThis, 'document', documentDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

describe('command-center WebMCP registration', () => {
  it('passes the command-center policy to the root Provider', () => {
    const layout = readFileSync('src/routes/+layout.svelte', 'utf8');

    expect(layout).toContain("from '$lib/webmcp'");
    expect(layout).toContain('...jobSearchWebMcpToolDefinitions');
    expect(layout).toContain('commandCenterWebMcpConfig(');
    expect(layout).toContain('<Provider {webmcp}>');
  });

  it('does not configure public pages or browsers without modelContext', () => {
    expect(
      commandCenterWebMcpConfig(webMcpToolDefinitions, '/', {
        modelContext: {},
      }),
    ).toBe(false);
    expect(commandCenterWebMcpConfig(webMcpToolDefinitions, '/admin', {})).toBe(
      false,
    );
  });

  it('admits only the twelve canonical job-search definition objects', () => {
    const forgedDefinition = {
      ...jobSearchWebMcpToolDefinitions[0],
      name: 'job_search_generated_write',
      action: 'generated-write',
      effect: 'write' as const,
      readOnly: false,
      route: {
        method: 'POST' as const,
        scope: 'collection' as const,
        path: ['generated-write'],
      },
    };
    const config = commandCenterWebMcpConfig(
      [...jobSearchWebMcpToolDefinitions, forgedDefinition],
      '/admin/opportunities',
      { modelContext: {} },
    );

    if (!config) throw new Error('Expected admin WebMCP configuration');
    expect(config.definitions).toEqual(jobSearchWebMcpToolDefinitions);
    expect(config.definitions).not.toContain(forgedDefinition);
  });

  it('never admits candidate profile or reusable-answer collections', () => {
    // Candidate profiles hold private contact data (phone, location, work
    // authorization) and candidate answers hold the private reusable answer
    // library. Neither may become a browser WebMCP read tool.
    const base = jobSearchWebMcpToolDefinitions[0];
    const privateCollections = [
      {
        ...base,
        action: 'list',
        className: 'CandidateProfile',
        collection: 'candidate-profiles',
        name: 'candidate_profile_list',
      },
      {
        ...base,
        action: 'get',
        className: 'CandidateAnswer',
        collection: 'candidate-answers',
        name: 'candidate_answer_get',
      },
    ];
    const config = commandCenterWebMcpConfig(
      [...jobSearchWebMcpToolDefinitions, ...privateCollections],
      '/admin/candidate-profiles',
      { modelContext: {} },
    );

    if (!config) throw new Error('Expected admin WebMCP configuration');
    expect(config.definitions).toEqual(jobSearchWebMcpToolDefinitions);
    const admittedCollections = config.definitions.map((definition) =>
      'collection' in definition ? definition.collection : definition.name,
    );
    expect(admittedCollections).not.toContain('candidate-profiles');
    expect(admittedCollections).not.toContain('candidate-answers');
  });

  it('registers generated reads plus bounded job-search operations without invoking a tool', async () => {
    const registered: RegisteredTool[] = [];
    installModelContext(registered);

    const config = commandCenterWebMcpConfig(
      [...webMcpToolDefinitions, ...jobSearchWebMcpToolDefinitions],
      '/admin/opportunities',
    );
    if (!config) throw new Error('Expected admin WebMCP configuration');
    expect(config.basePath).toBe('/api');
    expect(config.effects).toEqual(['read', 'write']);
    expect(config.maxTools).toBe(17);
    expect(
      new Set(
        config.definitions.map((definition) =>
          'collection' in definition ? definition.collection : definition.name,
        ),
      ),
    ).toEqual(new Set(['opportunities', 'job-search']));

    const dispose = registerWebMcpTools(config.definitions, config);
    await dispose.ready;

    const expectedNames = config.definitions
      .filter(isReadDefinition)
      .map((definition) => definition.name)
      .sort();
    expect(registered.map((tool) => tool.name).sort()).toEqual([
      'job_search_browse_opportunities',
      'job_search_crawl_source',
      'job_search_dig_deeper',
      'job_search_import_opportunity',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_list_source_health',
      'job_search_next_triage_candidate',
      'job_search_open_application',
      'job_search_read_resume',
      'job_search_record_decision',
      'job_search_set_source_active',
      'job_search_source_crawl_status',
      'job_search_sweep_opportunities',
      'job_search_verify_posting',
      'opportunity_get',
      'opportunity_list',
    ]);
    expect(expectedNames).toEqual([
      'job_search_browse_opportunities',
      'job_search_inspect_application',
      'job_search_inspect_opportunity',
      'job_search_list_source_health',
      'job_search_next_triage_candidate',
      'job_search_read_resume',
      'job_search_source_crawl_status',
      'opportunity_get',
      'opportunity_list',
    ]);
    const writes = registered.filter(
      (tool) => tool.annotations?.readOnlyHint === false,
    );
    expect(writes.map((tool) => tool.name).sort()).toEqual([
      'job_search_crawl_source',
      'job_search_dig_deeper',
      'job_search_import_opportunity',
      'job_search_open_application',
      'job_search_record_decision',
      'job_search_set_source_active',
      'job_search_sweep_opportunities',
      'job_search_verify_posting',
    ]);
    const readOnly = registered.filter(
      (tool) => tool.annotations?.readOnlyHint === true,
    );
    expect(readOnly.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'job_search_inspect_application',
        'job_search_read_resume',
      ]),
    );
    expect(registered.some((tool) => tool.name === 'opportunity_create')).toBe(
      false,
    );
    expect(
      registered.some((tool) =>
        [
          'application_get',
          'application_list',
          'candidate_answer_get',
          'candidate_answer_list',
          'candidate_profile_get',
          'candidate_profile_list',
          'task_get',
          'task_list',
        ].includes(tool.name),
      ),
    ).toBe(false);

    dispose();
  });

  it('maps canonical job-search tools to their same-origin REST routes', async () => {
    const registered: RegisteredTool[] = [];
    const requests: Array<{ body: string; method: string; url: string }> = [];
    installModelContext(registered);
    const config = commandCenterWebMcpConfig(
      jobSearchWebMcpToolDefinitions,
      '/admin/opportunities',
    );
    if (!config) throw new Error('Expected admin WebMCP configuration');
    const fetchFn = async (input: string | URL, init?: RequestInit) => {
      requests.push({
        body: typeof init?.body === 'string' ? init.body : '',
        method: init?.method ?? 'GET',
        url: String(input),
      });
      return Response.json({ ok: true });
    };
    const dispose = registerWebMcpTools(config.definitions, {
      ...config,
      fetchFn: fetchFn as typeof fetch,
    });
    await dispose.ready;

    await registered
      .find((tool) => tool.name === 'job_search_browse_opportunities')
      ?.execute({ limit: 5, query: 'platform' });
    await registered
      .find((tool) => tool.name === 'job_search_record_decision')
      ?.execute({ decision: 'maybe', opportunityId: 'opp-1' });
    await registered
      .find((tool) => tool.name === 'job_search_list_source_health')
      ?.execute({ historyLimit: 3, limit: 5 });
    await registered
      .find((tool) => tool.name === 'job_search_crawl_source')
      ?.execute({
        idempotencyKey: 'qa-run-2026-08-31',
        reason: 'QA',
        sourceId: '11111111-1111-4111-8111-111111111111',
      });
    await registered
      .find((tool) => tool.name === 'job_search_inspect_application')
      ?.execute({ applicationId: 'app-1' });
    await registered
      .find((tool) => tool.name === 'job_search_read_resume')
      ?.execute({ tailoring: 'canonical' });
    await registered
      .find((tool) => tool.name === 'job_search_verify_posting')
      ?.execute({ opportunityId: 'opp-1' });

    expect(requests).toEqual([
      {
        body: '',
        method: 'GET',
        url: '/api/job-search/browse?limit=5&query=platform',
      },
      {
        body: JSON.stringify({
          decision: 'maybe',
          opportunityId: 'opp-1',
        }),
        method: 'POST',
        url: '/api/job-search/record-decision',
      },
      {
        body: '',
        method: 'GET',
        url: '/api/job-search/source-health?historyLimit=3&limit=5',
      },
      {
        body: JSON.stringify({
          idempotencyKey: 'qa-run-2026-08-31',
          reason: 'QA',
          sourceId: '11111111-1111-4111-8111-111111111111',
        }),
        method: 'POST',
        url: '/api/job-search/crawl-source',
      },
      {
        body: '',
        method: 'GET',
        url: '/api/job-search/inspect-application?applicationId=app-1',
      },
      {
        body: '',
        method: 'GET',
        url: '/api/job-search/read-resume?tailoring=canonical',
      },
      {
        body: JSON.stringify({ opportunityId: 'opp-1' }),
        method: 'POST',
        url: '/api/job-search/verify-posting',
      },
    ]);
    dispose();
  });

  it('keeps task-oriented write schemas bounded and explicit', () => {
    const byName = new Map(
      jobSearchWebMcpToolDefinitions.map((definition) => [
        definition.name,
        definition,
      ]),
    );
    expect(byName.get('job_search_record_decision')).toMatchObject({
      effect: 'write',
      openWorld: true,
      inputSchema: {
        additionalProperties: false,
        required: ['opportunityId', 'decision'],
      },
    });
    expect(byName.get('job_search_import_opportunity')).toMatchObject({
      effect: 'write',
      idempotent: false,
      openWorld: true,
      route: { method: 'POST', path: ['import'] },
    });
    expect(byName.get('job_search_open_application')).toMatchObject({
      effect: 'write',
      idempotent: false,
      openWorld: true,
    });
    expect(byName.get('job_search_crawl_source')).toMatchObject({
      effect: 'write',
      idempotent: true,
      openWorld: true,
      inputSchema: {
        additionalProperties: false,
        required: ['sourceId', 'idempotencyKey', 'reason'],
      },
    });
    expect(byName.get('job_search_set_source_active')).toMatchObject({
      effect: 'write',
      idempotent: true,
      openWorld: false,
      inputSchema: {
        additionalProperties: false,
        required: ['sourceId', 'active', 'reason'],
      },
    });
    for (const name of [
      'job_search_open_application',
      'job_search_record_decision',
      'job_search_verify_posting',
    ]) {
      expect(byName.get(name)?.inputSchema.properties).not.toHaveProperty(
        'preflightOverrideReason',
      );
    }
    expect(JSON.stringify(jobSearchWebMcpToolDefinitions)).not.toContain(
      'preflightOverrideReason',
    );
  });

  it('publishes the inactive-source sweep as dry-run-first', () => {
    const byName = new Map(
      jobSearchWebMcpToolDefinitions.map((definition) => [
        definition.name,
        definition,
      ]),
    );
    const sweep = byName.get('job_search_sweep_opportunities');
    expect(sweep).toMatchObject({
      effect: 'write',
      // Each apply writes a new audit run and the cutoff moves with the clock.
      idempotent: false,
      openWorld: false,
      readOnly: false,
      route: { method: 'POST', path: ['sweep'] },
      inputSchema: { additionalProperties: false },
    });
    expect(sweep?.inputSchema.required).toBeUndefined();
    expect(sweep?.inputSchema.properties).toMatchObject({
      dryRun: { type: 'boolean', default: true },
      notSeenDays: { type: 'integer', default: 30, maximum: 3650, minimum: 1 },
    });
    expect(Object.keys(sweep?.inputSchema.properties ?? {})).toEqual([
      'dryRun',
      'notSeenDays',
    ]);
    expect(sweep?.description).toMatch(/dry run/i);
  });

  it('keeps the preflight, application, and resume reads bounded and explicit', () => {
    const byName = new Map(
      jobSearchWebMcpToolDefinitions.map((definition) => [
        definition.name,
        definition,
      ]),
    );
    expect(byName.get('job_search_verify_posting')).toMatchObject({
      effect: 'write',
      idempotent: false,
      openWorld: true,
      readOnly: false,
      inputSchema: {
        additionalProperties: false,
        required: ['opportunityId'],
      },
      route: { method: 'POST', path: ['verify-posting'] },
    });
    expect(
      Object.keys(
        byName.get('job_search_verify_posting')?.inputSchema.properties ?? {},
      ),
    ).toEqual(['opportunityId']);
    expect(byName.get('job_search_inspect_application')).toMatchObject({
      effect: 'read',
      idempotent: true,
      openWorld: false,
      readOnly: true,
      inputSchema: {
        additionalProperties: false,
        required: ['applicationId'],
      },
      route: { method: 'GET', path: ['inspect-application'] },
    });
    expect(byName.get('job_search_inspect_application')?.description).toMatch(
      /answer library/i,
    );
    expect(byName.get('job_search_read_resume')).toMatchObject({
      effect: 'read',
      idempotent: true,
      openWorld: false,
      readOnly: true,
      inputSchema: { additionalProperties: false },
      route: { method: 'GET', path: ['read-resume'] },
    });
    expect(
      Object.keys(
        byName.get('job_search_read_resume')?.inputSchema.properties ?? {},
      ),
    ).toEqual(['tailoring', 'profileKey']);
    expect(byName.get('job_search_read_resume')?.description).toMatch(
      /Email, phone, location, work-authorization/,
    );
  });
});
