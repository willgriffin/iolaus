/**
 * Input contracts for the application-owned `job_search_*` WebMCP tools.
 *
 * This module is the single definition of each tool's `inputSchema`. The
 * browser registration (`$lib/webmcp`) publishes these schemas to
 * `document.modelContext`, and the `/api/job-search/[action]` route validates
 * incoming arguments against the very same objects, so what an agent is told
 * it may send is exactly what the server accepts. It is intentionally free of
 * browser and server imports so both sides can load it.
 */

export type ToolPropertyType = 'boolean' | 'integer' | 'number' | 'string';

export interface ToolPropertySchema {
  type: ToolPropertyType;
  default?: boolean | number | string;
  description?: string;
  enum?: readonly string[];
  format?: 'uri' | 'uuid';
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
}

export interface ToolInputSchema {
  $schema: 'https://json-schema.org/draft/2020-12/schema';
  type: 'object';
  additionalProperties: false;
  properties: Readonly<Record<string, ToolPropertySchema>>;
  required?: readonly string[];
  /** Bounded alternative-requirements form: at least one branch must hold. */
  anyOf?: readonly { required: readonly string[] }[];
}

export interface JobSearchToolContract {
  inputSchema: ToolInputSchema;
  method: 'GET' | 'POST';
}

const JSON_SCHEMA = 'https://json-schema.org/draft/2020-12/schema' as const;

const identifierSchema = {
  type: 'string',
  format: 'uuid',
  description: 'Local opportunity identifier',
} as const satisfies ToolPropertySchema;

const applicationIdentifierSchema = {
  type: 'string',
  format: 'uuid',
  description: 'Local application identifier',
} as const satisfies ToolPropertySchema;

const sourceIdentifierSchema = {
  type: 'string',
  format: 'uuid',
  description: 'Explicit local root-source identifier',
} as const satisfies ToolPropertySchema;

/** Tool name → HTTP method and argument schema. */
export const jobSearchToolContracts = {
  job_search_create_source: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        active: {
          type: 'boolean',
          default: true,
          description:
            'Whether the new root is eligible for a later explicit crawl. Creating it never contacts the provider.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 160,
          description: 'A local label for this job source',
        },
        provider: {
          type: 'string',
          enum: ['ashby', 'greenhouse', 'lever', 'generic-careers'],
          description: 'The provider that owns the public root URL',
        },
        type: {
          type: 'string',
          enum: [
            'job_board',
            'company_careers',
            'contract_board',
            'recruiter',
            'search_query',
            'manual',
          ],
          default: 'company_careers',
        },
        url: {
          type: 'string',
          format: 'uri',
          minLength: 1,
          maxLength: 2048,
          description:
            'Public HTTPS provider root, never an individual posting or credential-bearing URL',
        },
      },
      required: ['name', 'provider', 'url'],
    },
  },
  job_search_list_source_health: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', maxLength: 120 },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        historyLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 10,
        },
      },
    },
  },
  job_search_source_crawl_status: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        crawlId: {
          ...sourceIdentifierSchema,
          description: 'Explicit crawl identifier',
        },
        sourceId: sourceIdentifierSchema,
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      },
      anyOf: [{ required: ['crawlId'] }, { required: ['sourceId'] }],
    },
  },
  job_search_set_source_active: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: sourceIdentifierSchema,
        active: { type: 'boolean' },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['sourceId', 'active', 'reason'],
    },
  },
  job_search_crawl_source: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceId: sourceIdentifierSchema,
        idempotencyKey: { type: 'string', minLength: 8, maxLength: 128 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      required: ['sourceId', 'idempotencyKey', 'reason'],
    },
  },
  job_search_browse_opportunities: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description:
            'Optional text matched against title, company, summary, skills, location, and posting URL',
        },
        status: {
          type: 'string',
          maxLength: 40,
          default: 'all',
          description:
            'Opportunity lifecycle status, or all. Archived rows are excluded from all and from every count; pass status archived to list them.',
        },
        decision: {
          type: 'string',
          enum: ['all', 'unsorted', 'apply', 'maybe', 'reject'],
          default: 'all',
          description: 'Recorded user decision filter',
        },
        workMode: {
          type: 'string',
          enum: ['all', 'remote', 'hybrid', 'onsite', 'unknown'],
          default: 'all',
        },
        employmentType: {
          type: 'string',
          enum: [
            'all',
            'full_time',
            'contract',
            'fractional',
            'advisory',
            'founder',
            'unknown',
          ],
          default: 'all',
        },
        postedWithinDays: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
        },
        minScore: { type: 'number', minimum: 0, maximum: 100 },
        minRating: { type: 'integer', minimum: 1, maximum: 10 },
        excludeExpired: { type: 'boolean', default: true },
        sort: {
          type: 'string',
          enum: ['best', 'newest', 'score', 'salary', 'rating'],
          default: 'best',
        },
        sortDirection: {
          type: 'string',
          enum: ['asc', 'desc'],
          default: 'desc',
        },
        limit: { type: 'integer', minimum: 1, maximum: 25, default: 10 },
        offset: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
      },
    },
  },
  job_search_next_triage_candidate: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description:
            'Optional text matched against title, company, summary, skills, location, and posting URL',
        },
        workMode: {
          type: 'string',
          enum: ['all', 'remote', 'hybrid', 'onsite', 'unknown'],
          default: 'all',
        },
        employmentType: {
          type: 'string',
          enum: [
            'all',
            'full_time',
            'contract',
            'fractional',
            'advisory',
            'founder',
            'unknown',
          ],
          default: 'all',
        },
        postedWithinDays: { type: 'integer', minimum: 1, maximum: 365 },
        minScore: { type: 'number', minimum: 0, maximum: 100 },
        minRating: { type: 'integer', minimum: 1, maximum: 10 },
        sort: {
          type: 'string',
          enum: ['score', 'newest'],
          default: 'score',
          description:
            'Queue ordering: best match first, or most recently posted first. The same two orderings the admin triage deck offers.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: 1000,
          default: 0,
          description:
            'Skip this many candidates. There is no server-side skip list: raise the offset to pass on a candidate without recording anything.',
        },
      },
    },
  },
  job_search_inspect_opportunity: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: { opportunityId: identifierSchema },
      required: ['opportunityId'],
    },
  },
  job_search_verify_posting: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: { opportunityId: identifierSchema },
      required: ['opportunityId'],
    },
  },
  job_search_sweep_opportunities: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: {
          type: 'boolean',
          default: true,
          description:
            'Report the matching count and a sample without writing. Pass false to archive the matched rows.',
        },
        notSeenDays: {
          type: 'integer',
          minimum: 1,
          maximum: 3650,
          default: 30,
          description:
            'Archive matched opportunities whose last_seen_at is older than this many days',
        },
      },
    },
  },
  job_search_inspect_application: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: { applicationId: applicationIdentifierSchema },
      required: ['applicationId'],
    },
  },
  job_search_read_resume: {
    method: 'GET',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        tailoring: {
          type: 'string',
          maxLength: 120,
          description:
            'Optional stored tailoring config slug; omit for the canonical resume',
        },
        profileKey: {
          type: 'string',
          maxLength: 120,
          description:
            'Optional candidate profile key; omit for the default profile. The response lists the selectable profiles.',
        },
      },
    },
  },
  job_search_import_opportunity: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          maxLength: 2048,
          description: 'Public HTTPS job-posting URL',
        },
        title: {
          type: 'string',
          maxLength: 300,
          description:
            'Optional title to retain if the posting cannot be parsed',
        },
        refreshExisting: {
          type: 'boolean',
          default: false,
          description:
            'Refresh supported posting details for an existing URL match',
        },
      },
      required: ['url'],
    },
  },
  job_search_record_decision: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        opportunityId: identifierSchema,
        decision: { type: 'string', enum: ['apply', 'maybe', 'reject'] },
        reason: { type: 'string', maxLength: 2000 },
        reviewedByProfileId: { type: 'string', format: 'uuid' },
      },
      required: ['opportunityId', 'decision'],
    },
  },
  job_search_dig_deeper: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        opportunityId: identifierSchema,
        reason: {
          type: 'string',
          maxLength: 2000,
          description:
            'Review notes to record with the verdict. Omit to keep the notes already on the opportunity.',
        },
        rating: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description:
            'Owner rating to record. Omit to keep the recorded rating.',
        },
        reviewedByProfileId: { type: 'string', format: 'uuid' },
      },
      required: ['opportunityId'],
    },
  },
  job_search_open_application: {
    method: 'POST',
    inputSchema: {
      $schema: JSON_SCHEMA,
      type: 'object',
      additionalProperties: false,
      properties: {
        opportunityId: identifierSchema,
        reason: { type: 'string', maxLength: 2000 },
        reviewedByProfileId: { type: 'string', format: 'uuid' },
      },
      required: ['opportunityId'],
    },
  },
} as const satisfies Readonly<Record<string, JobSearchToolContract>>;

export type JobSearchToolName = keyof typeof jobSearchToolContracts;

export function isJobSearchToolName(value: string): value is JobSearchToolName {
  return Object.hasOwn(jobSearchToolContracts, value);
}
