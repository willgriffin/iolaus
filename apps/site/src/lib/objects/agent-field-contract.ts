export class AgentFieldContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFieldContractError';
  }
}

const agentListFieldContracts = [
  { className: 'Company', fields: ['industryTags'] },
  { className: 'Decision', fields: ['decisionTags'] },
  {
    className: 'Opportunity',
    fields: [
      'locations',
      'requiredSkills',
      'preferredSkills',
      'domainTags',
      'roleTags',
    ],
  },
  {
    className: 'ResumeVariant',
    fields: [
      'emphasizeTags',
      'excludeTags',
      'includePositionIds',
      'excludePositionIds',
    ],
  },
] as const;

const agentJsonFieldContracts = [
  {
    className: 'AgentRun',
    fields: {
      approvalSnapshotJson: '{}',
      inputJson: '{}',
      outputJson: '{}',
    },
  },
  {
    className: 'EvaluationScore',
    fields: {
      reasonJson: '{}',
    },
  },
  {
    className: 'FactIntake',
    fields: {
      extractedCandidatesJson: '[]',
    },
  },
  {
    className: 'PreferenceRule',
    fields: {
      ruleJson: '{}',
    },
  },
  {
    className: 'ResumeTailoringConfig',
    fields: {
      configJson: '{}',
    },
  },
  {
    className: 'SourceCrawl',
    fields: {
      filtersJson: '{}',
      preferenceSnapshotJson: '{}',
      tagsJson: '[]',
    },
  },
  {
    className: 'SourceCrawlItem',
    fields: {
      rawJson: '{}',
    },
  },
  {
    className: 'Task',
    fields: {
      artifactRefsJson: '{}',
    },
  },
] as const;

export const agentListFieldDescription =
  'Newline-delimited list. API and MCP writes may send string[]; writes are stored one item per line.';

export const agentJsonFieldDescription =
  'Canonical JSON string. API and MCP writes may send JSON objects/arrays; writes are stored as stable JSON text.';

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function unsupportedJsonValue(): never {
  throw new AgentFieldContractError('JSON fields must be serializable JSON.');
}

function compactListItem(value: unknown): string {
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new AgentFieldContractError(
      'List fields must contain string, number, or boolean values.',
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new AgentFieldContractError(
      'List fields must contain finite number values.',
    );
  }
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAgentListField(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value.map((item) => compactListItem(item))
    : typeof value === 'string'
      ? value.split(/\r?\n/).map((item) => compactListItem(item))
      : [compactListItem(value)];

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of values) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

export function serializeAgentListField(value: unknown): string {
  return parseAgentListField(value).join('\n');
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === undefined) unsupportedJsonValue();
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) unsupportedJsonValue();
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item));
  }
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      unsupportedJsonValue();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalizeJsonValue(item)]),
    );
  }

  unsupportedJsonValue();
}

export function serializeAgentJsonField(
  value: unknown,
  defaultValue = '{}',
): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return defaultValue;
    try {
      return JSON.stringify(normalizeJsonValue(JSON.parse(trimmed)));
    } catch {
      throw new AgentFieldContractError('JSON fields must contain valid JSON.');
    }
  }

  if (value === undefined || value === null) return defaultValue;

  try {
    return JSON.stringify(normalizeJsonValue(value));
  } catch {
    throw new AgentFieldContractError('JSON fields must be serializable JSON.');
  }
}

export function normalizeAgentWritablePayload(
  className: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const listFields =
    agentListFieldContracts.find((contract) => contract.className === className)
      ?.fields ?? [];
  for (const key of listFields) {
    if (Object.hasOwn(payload, key)) {
      payload[key] = serializeAgentListField(payload[key]);
    }
  }

  const jsonFields =
    agentJsonFieldContracts.find((contract) => contract.className === className)
      ?.fields ?? {};
  for (const [key, defaultValue] of Object.entries(jsonFields)) {
    if (Object.hasOwn(payload, key)) {
      payload[key] = serializeAgentJsonField(
        payload[key],
        String(defaultValue),
      );
    }
  }

  return payload;
}
