import { describe, expect, it } from 'vitest';
import { buildOpportunityLlmExtractionMessages } from './opportunity-details.js';

const runLiveRepro = process.env.OPPORTUNITY_LLM_REPRO === '1';
const describeLive = runLiveRepro ? describe : describe.skip;
const defaultModel = 'zai/glm-4.7-flashx';
const defaultEndpoint =
  'https://models.example.invalid/openai/chat/completions';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function envString(name: string, fallback = ''): string {
  return stringValue(process.env[name]) || fallback;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function apiKey(): string {
  return (
    envString('OPPORTUNITY_LLM_REPRO_API_KEY') ||
    envString('BIFROST_OPPORTUNITY_INTELLIGENCE_API_KEY') ||
    envString('BIFROST_CHEAP_API_KEY') ||
    envString('BIFROST_API_KEY') ||
    envString('HAVE_AI_API_KEY')
  );
}

function buildReproOpportunity(): Record<string, unknown> {
  const section = [
    'Responsibilities include building TypeScript application services, maintaining SvelteKit admin workflows,',
    'designing PostgreSQL data models, integrating Kubernetes-deployed AI services, reviewing generated application materials,',
    'and improving agentic workflows that extract structured details from noisy job postings.',
    'Requirements include TypeScript, SvelteKit, Node.js, PostgreSQL, Docker, Kubernetes, observability, LLM APIs,',
    'structured JSON extraction, prompt debugging, and pragmatic product engineering.',
    'Nice to have experience with resume tailoring systems, ATS workflows, Bifrost gateways, Ollama, and local model operations.',
  ].join(' ');
  const postingText = [
    'Staff Software Engineer, AI Workflow Systems',
    'Company: Acme Workflows',
    'Location: Canada Remote',
    'Salary: CAD 160000 to CAD 220000',
    'Employment type: Full time',
    'Seniority: Staff',
    ...Array.from(
      { length: 95 },
      (_, index) => `Posting section ${index + 1}. ${section}`,
    ),
  ].join('\n\n');

  return {
    descriptionRaw: postingText,
    id: 'live-opportunity-llm-repro',
    locationNotes: 'Canada Remote',
    postingUrl: 'https://example.invalid/jobs/live-opportunity-llm-repro',
    title: 'Staff Software Engineer, AI Workflow Systems',
  };
}

function bodyPreview(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 800);
}

function parseJsonObjectFromText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return {};
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  }
}

function completionContent(body: unknown): string {
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice =
    choices[0] && typeof choices[0] === 'object'
      ? (choices[0] as Record<string, unknown>)
      : {};
  const message =
    firstChoice.message && typeof firstChoice.message === 'object'
      ? (firstChoice.message as Record<string, unknown>)
      : {};
  return (
    stringValue(message.content) ||
    stringValue(firstChoice.text) ||
    stringValue(record.content)
  );
}

const httpTimeoutMs = envNumber(
  'OPPORTUNITY_LLM_REPRO_HTTP_TIMEOUT_MS',
  70_000,
);
const expectedTimeoutMs = envNumber(
  'OPPORTUNITY_LLM_REPRO_EXPECT_TIMEOUT_MS',
  60_000,
);
const testTimeoutMs = httpTimeoutMs + 15_000;

describeLive('live opportunity LLM extraction repro', () => {
  it(
    'returns valid extraction JSON before the admin timeout',
    async () => {
      const endpoint = envString(
        'OPPORTUNITY_LLM_REPRO_ENDPOINT',
        defaultEndpoint,
      );
      const model = envString(
        'OPPORTUNITY_LLM_REPRO_MODEL',
        envString('BIFROST_CHEAP_MODEL', defaultModel),
      );
      const messages = buildOpportunityLlmExtractionMessages(
        buildReproOpportunity(),
      );
      const payload = {
        messages,
        model,
        stream: false,
        temperature: 0,
      };
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      const authToken = apiKey();
      if (authToken) headers.authorization = `Bearer ${authToken}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
      const started = Date.now();
      let response: Response;
      let text = '';

      try {
        response = await fetch(endpoint, {
          body: JSON.stringify(payload),
          headers,
          method: 'POST',
          signal: controller.signal,
        });
        text = await response.text();
      } catch (cause) {
        const elapsedMs = Date.now() - started;
        const message =
          cause instanceof Error
            ? `${cause.name}: ${cause.message}`
            : String(cause);
        throw new Error(
          [
            `Opportunity LLM repro did not receive an HTTP response after ${elapsedMs}ms.`,
            `endpoint=${endpoint}`,
            `model=${model}`,
            `error=${message}`,
          ].join('\n'),
        );
      } finally {
        clearTimeout(timeout);
      }

      const elapsedMs = Date.now() - started;
      console.info(
        [
          '[opportunity-llm-repro]',
          `endpoint=${endpoint}`,
          `model=${model}`,
          `status=${response.status}`,
          `elapsedMs=${elapsedMs}`,
          `bodyChars=${text.length}`,
          `promptChars=${JSON.stringify(messages).length}`,
        ].join(' '),
      );

      expect(
        response.ok,
        `Expected a successful chat completion response, got ${response.status} after ${elapsedMs}ms: ${bodyPreview(text)}`,
      ).toBe(true);
      expect(
        elapsedMs,
        `Expected extraction to finish within the admin timeout; got ${elapsedMs}ms.`,
      ).toBeLessThanOrEqual(expectedTimeoutMs);

      const body = JSON.parse(text) as unknown;
      const content = completionContent(body);
      expect(
        content,
        `No completion content in response: ${bodyPreview(text)}`,
      ).toBeTruthy();
      const extraction = parseJsonObjectFromText(content);
      expect(
        Object.keys(extraction).length,
        `Completion content was not a JSON object: ${bodyPreview(content)}`,
      ).toBeGreaterThan(0);
    },
    testTimeoutMs,
  );
});
