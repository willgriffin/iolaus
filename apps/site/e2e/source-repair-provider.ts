import { createServer, type IncomingMessage } from 'node:http';

type Json = Record<string, unknown>;
export interface RepairProviderEvent {
  kind:
    | 'base'
    | 'historical_feedback'
    | 'repair'
    | 'current_audit'
    | 'audit_replay';
  request: Json;
  nativeRepairIntent?: Json;
}
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Fictional repair provider expected an object');
  return value as Json;
}
async function payload(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_000_000) throw new Error('Fictional repair payload bound');
    chunks.push(bytes);
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

/** Only transport is fictional; native SDK parsing/governance stays real. */
export async function startRepairProvider(
  readNativeRepairIntent: () => Promise<Json | undefined>,
  options: { auditReplayOnly?: boolean } = {},
) {
  const events: RepairProviderEvent[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || events.length >= 24)
        throw new Error('Fictional repair provider request bound');
      const body = await payload(request);
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      response.setHeader('content-type', 'application/json');
      if (path.endsWith('/chat/completions')) {
        if (!Array.isArray(body.messages)) throw new Error('Messages missing');
        const user = body.messages
          .map(object)
          .find((row) => row.role === 'user');
        if (typeof user?.content !== 'string')
          throw new Error('User source missing');
        const marker =
          'Prepared posting payload with source-section provenance:\n';
        const repair = !user.content.includes(marker);
        const source = object(
          JSON.parse(
            repair
              ? user.content
              : user.content.slice(
                  user.content.indexOf(marker) + marker.length,
                ),
          ),
        );
        let output: Json;
        if (repair) {
          if (!Array.isArray(source.targets))
            throw new Error('Native repair targets missing');
          const targets = source.targets.map(object);
          output = {
            requirementCoverage: {
              requirements: targets.map((row, index) => ({
                id: 'repair_r' + index,
                text: row.text,
                clauseIds: [row.clauseId],
                importance: 'required',
              })),
              dispositions: targets.map((row, index) => ({
                clauseId: row.clauseId,
                type: 'material_requirement',
                requirementIds: [
                  ...(Array.isArray(row.existingRequirements)
                    ? row.existingRequirements.map(
                        (item) => (item as unknown[])[0],
                      )
                    : []),
                  'repair_r' + index,
                ],
              })),
              removedRequirementIds: [],
            },
          };
        } else {
          if (!Array.isArray(source.sourceClauses))
            throw new Error('Base source clauses missing');
          const clauses = source.sourceClauses.map(object);
          const bodyClauses = clauses.filter(
            (row) => row.text !== 'Requirements',
          );
          output = {
            requirementCoverage: {
              requirements: bodyClauses.map((row, index) => ({
                id: 'paid_r' + index,
                text: index === 0 ? row.text : 'Use TypeScript.',
                clauseIds: [row.id],
                importance: 'required',
              })),
              dispositions: clauses.map((row) =>
                row.text === 'Requirements'
                  ? {
                      clauseId: row.id,
                      type: 'nonrequirement',
                      requirementIds: [],
                      exclusionRule: 'section_heading',
                    }
                  : {
                      clauseId: row.id,
                      type: 'material_requirement',
                      requirementIds: ['paid_r' + bodyClauses.indexOf(row)],
                    },
              ),
            },
          };
        }
        events.push({
          kind: repair ? 'repair' : 'base',
          request: body,
          ...(repair
            ? { nativeRepairIntent: await readNativeRepairIntent() }
            : {}),
        });
        response.end(
          JSON.stringify({
            id: 'fictional-repair-response-' + events.length,
            object: 'chat.completion',
            created: 0,
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: JSON.stringify(output) },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 100,
              total_tokens: 200,
            },
          }),
        );
      } else if (path.endsWith('/systemone')) {
        const questions = object(body.questions);
        const historical = Object.keys(questions).some((key) =>
          key.endsWith('mapping_retains_all_material_meaning'),
        );
        const answers = Object.fromEntries(
          Object.keys(questions).map((key) => [
            key,
            {
              type: 'noul',
              noul: historical && key.startsWith('c2_') ? 0.2 : 0.99,
            },
          ]),
        );
        events.push({
          kind: historical
            ? 'historical_feedback'
            : options.auditReplayOnly ||
                events.some((row) => row.kind === 'current_audit')
              ? 'audit_replay'
              : 'current_audit',
          nativeRepairIntent: await readNativeRepairIntent(),
          request: body,
        });
        response.end(
          JSON.stringify({
            model: body.model,
            answers,
            usage: { input_tokens: 100, output_tokens: 100 },
          }),
        );
      } else throw new Error('Unexpected fictional repair endpoint');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error:
            error instanceof Error ? error.message : 'Fictional repair failure',
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
    throw new Error('No loopback repair port');
  return {
    url: 'http://127.0.0.1:' + address.port,
    events,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
