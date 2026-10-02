import { createServer, type IncomingMessage } from 'node:http';

type Json = Record<string, unknown>;
export interface SourceStageProviderEvent {
  kind: 'extraction' | 'audit' | 'private';
  request: Json;
  job?: Json;
  failed: boolean;
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Fictional stage provider requires an object');
  return value as Json;
}
async function payload(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_000_000) throw new Error('Fictional stage payload bound');
    chunks.push(bytes);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
/** Only the loopback provider transport is fictional; SDK/governance/jobs are native. */
export async function startSourceStageProvider(
  readJob: () => Promise<Json | undefined>,
  options: { failExtraction?: boolean; partialEvidence?: boolean } = {},
) {
  const events: SourceStageProviderEvent[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || events.length >= 4)
        throw new Error('Fictional stage provider call bound');
      const body = await payload(request);
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const extraction = path.endsWith('/chat/completions');
      if (!extraction && !path.endsWith('/systemone'))
        throw new Error('Unexpected fictional stage endpoint');
      const privateAssessment =
        !extraction && 'candidates' in object(body.state);
      events.push({
        kind: extraction
          ? 'extraction'
          : privateAssessment
            ? 'private'
            : 'audit',
        request: body,
        job: await readJob(),
        failed: extraction && Boolean(options.failExtraction),
      });
      response.setHeader('content-type', 'application/json');
      if (extraction && options.failExtraction) {
        response.writeHead(400);
        response.end(
          JSON.stringify({ error: 'Fictional terminal extraction failure' }),
        );
        return;
      }
      if (extraction) {
        if (!Array.isArray(body.messages)) throw new Error('Messages missing');
        const user = body.messages
          .map(object)
          .find((row) => row.role === 'user');
        const marker =
          'Prepared posting payload with source-section provenance:\n';
        if (typeof user?.content !== 'string' || !user.content.includes(marker))
          throw new Error('Native source manifest missing');
        const prepared = object(
          JSON.parse(
            user.content.slice(user.content.indexOf(marker) + marker.length),
          ),
        );
        if (!Array.isArray(prepared.sourceClauses))
          throw new Error('Native clauses missing');
        const clauses = prepared.sourceClauses.map(object);
        const requirements: Json[] = [];
        const dispositions = clauses.map((clause, index) => {
          if (typeof clause.id !== 'string' || typeof clause.text !== 'string')
            throw new Error('Native clause identity missing');
          if (
            Array.isArray(prepared.headingClauseIds) &&
            prepared.headingClauseIds.includes(clause.id)
          )
            return {
              clauseId: clause.id,
              type: 'nonrequirement',
              requirementIds: [],
              exclusionRule: 'section_heading',
            };
          if (clause.text === 'Remote role.')
            return {
              clauseId: clause.id,
              type: 'source_context',
              requirementIds: [],
            };
          const id = 'literal_' + index;
          requirements.push({
            id,
            text: clause.text,
            clauseIds: [clause.id],
            importance: 'unknown',
          });
          return {
            clauseId: clause.id,
            type: 'material_requirement',
            requirementIds: [id],
          };
        });
        response.end(
          JSON.stringify({
            id: 'fictional-stage-extraction-' + events.length,
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    title: 'Provider rewritten fictional title',
                    workMode: 'onsite',
                    employmentType: 'contract',
                    requirementCoverage: { requirements, dispositions },
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 6000,
              completion_tokens: 4096,
              total_tokens: 10096,
            },
          }),
        );
      } else {
        const questions = object(body.questions);
        if (
          'candidate' in object(body.state) ||
          'candidateEvidence' in object(body.state)
        )
          throw new Error('Private candidate data crossed source stage');
        const supportKeys = Object.keys(questions).filter((key) =>
          key.endsWith('_support'),
        );
        const rejectedSupport = supportKeys.at(-1);
        const answers = Object.fromEntries(
          Object.entries(questions).map(([key, value]) => {
            if (object(value).type !== 'noul')
              throw new Error('Exact v6 predicate wire contract required');
            return [
              key,
              {
                type: 'noul',
                noul:
                  key.endsWith('_contains_candidate_criterion') ||
                  (options.partialEvidence && key.endsWith('_criterion'))
                    ? 0.01
                    : options.partialEvidence && key === rejectedSupport
                      ? 0.2
                      : 0.99,
              },
            ];
          }),
        );
        response.end(
          JSON.stringify({
            model: body.model,
            answers,
            usage: { input_tokens: 100, output_tokens: 100 },
          }),
        );
      }
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
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
    throw new Error('No fixture stage port');
  return {
    url: 'http://127.0.0.1:' + address.port,
    events,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
