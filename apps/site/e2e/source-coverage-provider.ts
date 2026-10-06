import {
  appendFileSync,
  chmodSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { basename, join } from 'node:path';

type JsonRecord = Record<string, unknown>;

export interface SourceCoverageProviderEvent {
  kind: 'source_extraction' | 'source_audit' | 'private_assessment';
  request: JsonRecord;
  failed: boolean;
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Fictional provider expected a JSON object');
  return value as JsonRecord;
}

async function body(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 2_000_000)
      throw new Error('Fictional provider request exceeds its fixture bound');
    chunks.push(buffer);
  }
  return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function extraction(payload: JsonRecord): JsonRecord {
  if (!Array.isArray(payload.messages))
    throw new Error('Fictional extraction messages missing');
  const message = payload.messages
    .map(record)
    .find((item) => item.role === 'user');
  if (typeof message?.content !== 'string')
    throw new Error('Fictional extraction user content missing');
  const marker = 'Prepared posting payload with source-section provenance:\n';
  const offset = message.content.indexOf(marker);
  if (offset < 0) throw new Error('Native source clause manifest missing');
  const prepared = record(
    JSON.parse(message.content.slice(offset + marker.length)),
  );
  if (!Array.isArray(prepared.sourceClauses) || !prepared.sourceClauses.length)
    throw new Error('Native source clauses missing');
  const clauses = prepared.sourceClauses.map(record);
  const requirements: JsonRecord[] = [];
  const dispositions = clauses.map((clause, index) => {
    if (typeof clause.id !== 'string' || typeof clause.text !== 'string')
      throw new Error('Native source clause identity missing');
    if (
      clause.kind === 'heading' ||
      /^(?:Requirements|Qualifications|Responsibilities)$/i.test(
        clause.text.trim(),
      )
    )
      return {
        clauseId: clause.id,
        type: 'nonrequirement',
        requirementIds: [],
        exclusionRule: 'section_heading',
      };
    const id = `fictional-literal-${index}`;
    // Preserve the complete captured wording. This fixture performs no
    // summarization, exclusion, taxonomy matching or candidate comparison.
    requirements.push({
      id,
      text: clause.text,
      clauseIds: [clause.id],
      importance: /\b(?:must|required)\b/i.test(clause.text)
        ? 'required'
        : 'unknown',
    });
    return {
      clauseId: clause.id,
      type: 'role_context',
      requirementIds: [id],
    };
  });
  return { requirementCoverage: { requirements, dispositions } };
}

function typedAnswers(payload: JsonRecord): JsonRecord {
  const state = record(payload.state);
  const questions = record(payload.questions);
  const sourceOnly = typeof state.source === 'string';
  if (sourceOnly && ('candidateEvidence' in state || 'candidate' in state))
    throw new Error('Candidate facts leaked into the source-only audit');
  const answers: JsonRecord = {};
  for (const [key, value] of Object.entries(questions)) {
    const question = record(value);
    if (question.type === 'noul') {
      // The audit checks our unchanged literal mappings. Private answers are
      // deliberately uncertain: missing support must never invent a gap or
      // employer claim merely to make a browser test look scored.
      const probability = sourceOnly ? 0.99 : 0.01;
      answers[key] = { type: 'noul', noul: probability };
    } else if (question.type === 'choice') {
      const criteria = record(question.criteria);
      const keys = Object.keys(criteria);
      if (!keys.length) throw new Error('Native choice options missing');
      const selected =
        ['unknown', 'uncertain', 'none'].find((key) => keys.includes(key)) ??
        keys[0];
      answers[key] = {
        type: 'choice',
        choice: selected,
        confidence: 1,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === selected ? 1 : 0]),
        ),
      };
    } else {
      throw new Error(`Unsupported native fixture question: ${question.type}`);
    }
  }
  return answers;
}

/** A bounded transport fixture, never an injected native evaluator or store. */
export async function startSourceCoverageProvider(root: string) {
  const directory = realpathSync(root);
  if (!basename(directory).startsWith('iolaus-mobile-e2e-'))
    throw new Error('Provider fixture requires the disposable E2E root');
  const eventsPath = join(directory, 'source-coverage-provider-events.jsonl');
  writeFileSync(eventsPath, '', { mode: 0o600 });
  chmodSync(eventsPath, 0o600);
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || ++calls > 200)
        throw new Error(
          'Fictional provider request outside its fixture bounds',
        );
      const payload = await body(request);
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const kind: SourceCoverageProviderEvent['kind'] = pathname.endsWith(
        '/chat/completions',
      )
        ? 'source_extraction'
        : pathname.endsWith('/systemone')
          ? typeof record(payload.state).source === 'string'
            ? 'source_audit'
            : 'private_assessment'
          : (() => {
              throw new Error('Unexpected fictional provider endpoint');
            })();
      const failed = JSON.stringify(payload).includes(
        '[qa:source-provider-failure]',
      );
      // Never persist request headers, API keys, cookies, or authorization.
      appendFileSync(
        eventsPath,
        `${JSON.stringify({ kind, request: payload, failed })}\n`,
      );
      response.setHeader('content-type', 'application/json');
      if (failed) {
        response.writeHead(500);
        response.end(
          JSON.stringify({
            error: 'Bounded fictional source-provider failure',
          }),
        );
        return;
      }
      if (kind === 'source_extraction') {
        response.end(
          JSON.stringify({
            id: `fictional-source-${calls}`,
            object: 'chat.completion',
            created: 0,
            model: payload.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify(extraction(payload)),
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 100,
              total_tokens: 200,
            },
          }),
        );
      } else {
        const answers = typedAnswers(payload);
        if (JSON.stringify(payload).includes('[qa:source-audit-malformed]'))
          delete answers[Object.keys(answers)[0]];
        response.end(
          JSON.stringify({
            model: payload.model,
            answers,
            usage: { input_tokens: 100, output_tokens: 100 },
          }),
        );
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : 'Fictional provider failed',
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fictional provider did not bind a local port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    eventsPath,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
