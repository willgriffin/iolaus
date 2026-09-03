import { describe, expect, it } from 'vitest';
import {
  jobSearchToolContracts,
  type ToolInputSchema,
} from '$lib/job-search-tool-schemas';
import {
  MAX_TOOL_ARGUMENT_ISSUES,
  validateToolArguments,
} from './tool-arguments';

const uuid = '11111111-1111-4111-8111-111111111111';

const schema: ToolInputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    note: { type: 'string', minLength: 2, maxLength: 5 },
    count: { type: 'integer', minimum: 1, maximum: 3 },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    flag: { type: 'boolean' },
  },
  required: ['id'],
};

function failure(
  args: Record<string, unknown>,
  source: 'body' | 'query' = 'body',
  target: ToolInputSchema = schema,
) {
  const result = validateToolArguments('tool', target, args, source);
  if (result.ok) throw new Error('Expected a validation failure');
  return result;
}

describe('validateToolArguments', () => {
  it('accepts a body that matches every constraint', () => {
    expect(
      validateToolArguments(
        'tool',
        schema,
        {
          id: uuid,
          mode: 'fast',
          note: 'ok',
          count: 2,
          ratio: 0.5,
          flag: true,
        },
        'body',
      ),
    ).toEqual({ ok: true });
  });

  it('reports unexpected properties first, then missing required ones', () => {
    const result = failure({ ident: uuid });
    expect(result.error).toBe(
      'Invalid arguments for tool: unexpected property "ident"; missing required property "id"',
    );
    expect(result.details.map((issue) => issue.code)).toEqual([
      'unexpected_property',
      'missing_required',
    ]);
    expect(result.details.map((issue) => issue.path)).toEqual(['ident', 'id']);
  });

  it('treats an explicit undefined as absent and null as a type error', () => {
    expect(failure({ id: undefined }).details[0]?.code).toBe(
      'missing_required',
    );
    expect(failure({ id: null }).details[0]).toEqual({
      code: 'invalid_type',
      message: 'property "id" must be a string, received null',
      path: 'id',
    });
  });

  it('enforces primitive types, enum, uuid format, and string length', () => {
    expect(failure({ id: 'not-a-uuid' }).details[0]?.code).toBe(
      'invalid_format',
    );
    expect(failure({ id: uuid, mode: 'FAST' }).details[0]).toEqual({
      code: 'invalid_enum',
      message: 'property "mode" must be one of "fast", "slow"',
      path: 'mode',
    });
    expect(failure({ id: uuid, note: 'x' }).details[0]?.code).toBe('too_short');
    expect(failure({ id: uuid, note: 'toolong' }).details[0]?.code).toBe(
      'too_long',
    );
    expect(failure({ id: uuid, flag: 'true' }).details[0]?.code).toBe(
      'invalid_type',
    );
    expect(failure({ id: uuid, count: 1.5 }).details[0]).toEqual({
      code: 'invalid_type',
      message: 'property "count" must be an integer, received 1.5',
      path: 'count',
    });
    expect(failure({ id: uuid, ratio: Number.NaN }).details[0]?.code).toBe(
      'invalid_type',
    );
  });

  it('enforces integer and number bounds', () => {
    expect(failure({ id: uuid, count: 0 }).details[0]?.code).toBe('too_small');
    expect(failure({ id: uuid, count: 4 }).details[0]?.code).toBe('too_large');
    expect(failure({ id: uuid, ratio: 1.5 }).details[0]).toEqual({
      code: 'too_large',
      message: 'property "ratio" must be at most 1',
      path: 'ratio',
    });
  });

  it('coerces query-string values by declared type and treats empty values as absent', () => {
    expect(
      validateToolArguments(
        'tool',
        schema,
        { id: uuid, count: '2', ratio: '0.25', flag: 'false', note: '' },
        'query',
      ),
    ).toEqual({ ok: true });
    expect(failure({ id: uuid, count: 'abc' }, 'query').details[0]).toEqual({
      code: 'invalid_type',
      message: 'property "count" must be an integer, received string',
      path: 'count',
    });
    expect(failure({ id: uuid, count: '2.5' }, 'query').details[0]?.code).toBe(
      'invalid_type',
    );
    expect(failure({ id: uuid, flag: 'yes' }, 'query').details[0]?.code).toBe(
      'invalid_type',
    );
    expect(failure({ id: '' }, 'query').details[0]?.code).toBe(
      'missing_required',
    );
    // Body arguments are never coerced.
    expect(failure({ id: uuid, count: '2' }).details[0]?.code).toBe(
      'invalid_type',
    );
  });

  it('honours anyOf alternatives made of required lists', () => {
    const crawlStatus =
      jobSearchToolContracts.job_search_source_crawl_status.inputSchema;
    expect(
      validateToolArguments('tool', crawlStatus, { sourceId: uuid }, 'query'),
    ).toEqual({ ok: true });
    expect(
      validateToolArguments('tool', crawlStatus, { crawlId: uuid }, 'body'),
    ).toEqual({ ok: true });
    expect(failure({ limit: '3' }, 'query', crawlStatus).details).toEqual([
      {
        code: 'missing_any_of',
        message: 'one of "crawlId" or "sourceId" is required',
        path: '',
      },
    ]);
  });

  it('caps the number of reported issues', () => {
    const args = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`extra${index}`, index]),
    );
    const result = failure({ id: uuid, ...args });
    expect(result.details).toHaveLength(MAX_TOOL_ARGUMENT_ISSUES);
    expect(result.error).toMatch(/; and 20 more$/);
  });

  it('accepts the published job-search contracts as-is', () => {
    for (const [name, contract] of Object.entries(jobSearchToolContracts)) {
      expect(contract.inputSchema.additionalProperties, name).toBe(false);
      expect(contract.inputSchema.type, name).toBe('object');
      for (const [key, property] of Object.entries(
        contract.inputSchema.properties,
      )) {
        expect(
          ['boolean', 'integer', 'number', 'string'],
          `${name}.${key}`,
        ).toContain(property.type);
      }
    }
  });
});
