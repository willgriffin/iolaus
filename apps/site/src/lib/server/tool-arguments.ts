import type {
  ToolInputSchema,
  ToolPropertySchema,
} from '$lib/job-search-tool-schemas';

/**
 * Bounded server-side validation of WebMCP tool arguments against the flat
 * object schemas in `$lib/job-search-tool-schemas`. It enforces exactly the
 * vocabulary those schemas use — `required`, `anyOf` of `required` branches,
 * `additionalProperties: false`, primitive `type`, `enum`, `format: 'uuid'`,
 * string `minLength`/`maxLength`, and numeric `minimum`/`maximum` — and
 * deliberately nothing more: no nested objects or arrays, no `$ref`, no
 * `pattern`, no `default` injection, and no `format: 'uri'` (the import
 * handler performs the authoritative public-URL checks). It never throws.
 */

export type ToolArgumentSource = 'body' | 'query';

export type ToolArgumentIssueCode =
  | 'invalid_enum'
  | 'invalid_format'
  | 'invalid_type'
  | 'missing_any_of'
  | 'missing_required'
  | 'too_large'
  | 'too_long'
  | 'too_short'
  | 'too_small'
  | 'unexpected_property';

export interface ToolArgumentIssue {
  code: ToolArgumentIssueCode;
  message: string;
  path: string;
}

export type ToolArgumentValidation =
  | { ok: true }
  | { details: ToolArgumentIssue[]; error: string; ok: false };

/** Upper bound on reported issues so a hostile payload cannot inflate the body. */
export const MAX_TOOL_ARGUMENT_ISSUES = 10;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^-?\d+$/;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Query-string arguments arrive as strings. Coerce those whose declared type
 * is not `string` so `limit=2` validates as the integer 2, and treat an empty
 * value as absent (the handlers already do). Values that do not coerce are
 * left as-is so the type check reports them.
 */
function coerceQueryArguments(
  args: Record<string, unknown>,
  schema: ToolInputSchema,
): Record<string, unknown> {
  const coerced: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(args)) {
    if (raw === '') continue;
    const property = schema.properties[key];
    if (!property || typeof raw !== 'string') {
      coerced[key] = raw;
      continue;
    }
    coerced[key] = coerceQueryValue(raw, property.type);
  }
  return coerced;
}

function coerceQueryValue(
  raw: string,
  type: ToolPropertySchema['type'],
): unknown {
  switch (type) {
    case 'boolean':
      return raw === 'true' ? true : raw === 'false' ? false : raw;
    case 'integer':
      return INTEGER_PATTERN.test(raw.trim()) ? Number(raw) : raw;
    case 'number': {
      const number = Number(raw);
      return raw.trim() !== '' && Number.isFinite(number) ? number : raw;
    }
    default:
      return raw;
  }
}

function hasValue(args: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(args, key) && args[key] !== undefined;
}

function checkProperty(
  key: string,
  value: unknown,
  property: ToolPropertySchema,
): ToolArgumentIssue | undefined {
  const issue = (
    code: ToolArgumentIssueCode,
    message: string,
  ): ToolArgumentIssue => ({ code, message, path: key });

  switch (property.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return issue(
          'invalid_type',
          `property "${key}" must be a string, received ${describe(value)}`,
        );
      }
      if (property.enum && !property.enum.includes(value)) {
        return issue(
          'invalid_enum',
          `property "${key}" must be one of ${property.enum
            .map((option) => `"${option}"`)
            .join(', ')}`,
        );
      }
      if (
        property.minLength !== undefined &&
        value.length < property.minLength
      ) {
        return issue(
          'too_short',
          `property "${key}" must be at least ${property.minLength} characters`,
        );
      }
      if (
        property.maxLength !== undefined &&
        value.length > property.maxLength
      ) {
        return issue(
          'too_long',
          `property "${key}" must be at most ${property.maxLength} characters`,
        );
      }
      if (property.format === 'uuid' && !UUID_PATTERN.test(value)) {
        return issue('invalid_format', `property "${key}" must be a UUID`);
      }
      return undefined;
    }
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : issue(
            'invalid_type',
            `property "${key}" must be a boolean, received ${describe(value)}`,
          );
    case 'integer':
    case 'number': {
      const isValidNumber =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (property.type === 'number' || Number.isInteger(value));
      if (!isValidNumber) {
        return issue(
          'invalid_type',
          `property "${key}" must be ${
            property.type === 'integer' ? 'an integer' : 'a number'
          }, received ${
            typeof value === 'number' ? String(value) : describe(value)
          }`,
        );
      }
      if (property.minimum !== undefined && value < property.minimum) {
        return issue(
          'too_small',
          `property "${key}" must be at least ${property.minimum}`,
        );
      }
      if (property.maximum !== undefined && value > property.maximum) {
        return issue(
          'too_large',
          `property "${key}" must be at most ${property.maximum}`,
        );
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Validate `args` for `toolName`. `source: 'query'` first coerces the string
 * values a `URLSearchParams` object yields; `source: 'body'` validates the
 * parsed JSON as-is. The returned `error` is a single bounded sentence suitable
 * for the `{ error }` envelope the WebMCP client surfaces verbatim.
 */
export function validateToolArguments(
  toolName: string,
  schema: ToolInputSchema,
  args: Record<string, unknown>,
  source: ToolArgumentSource,
): ToolArgumentValidation {
  const values =
    source === 'query' ? coerceQueryArguments(args, schema) : { ...args };
  const issues: ToolArgumentIssue[] = [];

  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(schema.properties, key)) {
      issues.push({
        code: 'unexpected_property',
        message: `unexpected property "${key}"`,
        path: key,
      });
    }
  }

  for (const key of schema.required ?? []) {
    if (!hasValue(values, key)) {
      issues.push({
        code: 'missing_required',
        message: `missing required property "${key}"`,
        path: key,
      });
    }
  }

  if (
    schema.anyOf &&
    !schema.anyOf.some((branch) =>
      branch.required.every((key) => hasValue(values, key)),
    )
  ) {
    const alternatives = schema.anyOf.map((branch) =>
      branch.required.map((key) => `"${key}"`).join(' and '),
    );
    issues.push({
      code: 'missing_any_of',
      message: `one of ${alternatives.join(' or ')} is required`,
      path: '',
    });
  }

  for (const [key, property] of Object.entries(schema.properties)) {
    if (!hasValue(values, key)) continue;
    const issue = checkProperty(key, values[key], property);
    if (issue) issues.push(issue);
  }

  if (issues.length === 0) return { ok: true };

  const details = issues.slice(0, MAX_TOOL_ARGUMENT_ISSUES);
  const omitted = issues.length - details.length;
  const summary = details.map((issue) => issue.message).join('; ');
  return {
    details,
    error: `Invalid arguments for ${toolName}: ${summary}${
      omitted > 0 ? `; and ${omitted} more` : ''
    }`,
    ok: false,
  };
}
