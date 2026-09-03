export interface LlmJsonParseDiagnostics extends Record<string, unknown> {
  rawContentLength: number;
  rawContentPreview: string;
  rawContentTruncated: boolean;
}

const rawContentPreviewLimit = 4_000;

export class LlmJsonParseError extends Error {
  diagnostics: LlmJsonParseDiagnostics;

  constructor(label: string, rawContent: string) {
    super(`${label} returned invalid JSON.`);
    this.name = 'LlmJsonParseError';
    this.diagnostics = {
      rawContentLength: rawContent.length,
      rawContentPreview: rawContent.slice(0, rawContentPreviewLimit),
      rawContentTruncated: rawContent.length > rawContentPreviewLimit,
    };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    return objectRecord(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = start; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

export function tryParseJsonObjectFromText(
  text: string,
): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return null;

  const parsed = parseJsonObject(trimmed);
  if (parsed) return parsed;

  let searchFrom = 0;
  while (searchFrom < trimmed.length) {
    const start = trimmed.indexOf('{', searchFrom);
    if (start === -1) return null;

    const end = balancedObjectEnd(trimmed, start);
    if (end === -1) {
      searchFrom = start + 1;
      continue;
    }

    const candidate = trimmed.slice(start, end + 1);
    const candidateParsed = parseJsonObject(candidate);
    if (candidateParsed) return candidateParsed;

    searchFrom = start + 1;
  }

  return null;
}

export function parseJsonObjectFromText(text: string): Record<string, unknown> {
  return tryParseJsonObjectFromText(text) ?? {};
}

export function requireJsonObjectFromText(
  text: string,
  label: string,
): Record<string, unknown> {
  const parsed = tryParseJsonObjectFromText(text);
  if (!parsed) throw new LlmJsonParseError(label, text);
  return parsed;
}

export function llmJsonParseDiagnostics(
  error: unknown,
): LlmJsonParseDiagnostics | undefined {
  if (error instanceof LlmJsonParseError) return error.diagnostics;
  if (!error || typeof error !== 'object') return undefined;

  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  if (!diagnostics || typeof diagnostics !== 'object') return undefined;

  const record = diagnostics as Record<string, unknown>;
  if (
    typeof record.rawContentLength !== 'number' ||
    typeof record.rawContentPreview !== 'string' ||
    typeof record.rawContentTruncated !== 'boolean'
  ) {
    return undefined;
  }

  return {
    rawContentLength: record.rawContentLength,
    rawContentPreview: record.rawContentPreview,
    rawContentTruncated: record.rawContentTruncated,
  };
}
