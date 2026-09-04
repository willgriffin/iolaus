import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestJsonResult } from '@happyvertical/smrt-app-cli';
import { getCliConfigDirectory, getCliServerUrl } from '../src/app-config.js';

interface CliSmokeOptions {
  server?: string;
}

interface RunResult {
  stderr: string;
  stdout: string;
}

interface ResourceCommand {
  commandName: string;
  httpMethod: string;
  kind: string;
  methodName: string;
  pathSegments: string[];
  scope: 'collection' | 'item';
}

interface CliResource {
  apiPath: string;
  className: string;
  commands: ResourceCommand[];
  label: string;
  slug: string;
}

interface ResourceListResponse {
  resources: CliResource[];
  user: { authenticated: boolean };
  warnings: string[];
}

interface McpCallResult {
  content: Array<{
    text?: string;
    type: string;
  }>;
}

interface McpToolsResult {
  tools: Array<{
    inputSchema?: Record<string, unknown>;
    name: string;
  }>;
}

interface FakeServer {
  close: () => Promise<void>;
  url: string;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, '..');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertCliServerSelection(): void {
  const environment = {} as NodeJS.ProcessEnv;
  const selected = getCliServerUrl(
    ['auth', 'login', '--server=https://jobs.example.com/'],
    environment,
  );
  assert(
    selected === 'https://jobs.example.com',
    'CLI server selection must be canonical.',
  );
  assert(
    getCliConfigDirectory(['--server', selected], environment) !==
      getCliConfigDirectory(
        ['--server', 'https://other.example.com'],
        environment,
      ),
    'CLI credential namespaces must follow the selected server.',
  );
  let duplicateRejected = false;
  try {
    getCliServerUrl(
      [
        '--server',
        'https://one.example.com',
        '--server=https://two.example.com',
      ],
      environment,
    );
  } catch {
    duplicateRejected = true;
  }
  assert(duplicateRejected, 'Duplicate CLI server selectors must fail closed.');
}

function parseOptions(argv: string[]): CliSmokeOptions {
  const options: CliSmokeOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      if (index === 0) continue;
      break;
    }
    if (arg === '--server') {
      const value = argv[index + 1];
      assert(
        value && !value.startsWith('--'),
        'Missing value for smoke option: --server',
      );
      options.server = value;
      index += 1;
    } else if (arg?.startsWith('--server=')) {
      const value = arg.slice('--server='.length);
      assert(value, 'Missing value for smoke option: --server');
      options.server = value;
    } else {
      throw new Error(`Unknown smoke option: ${arg}`);
    }
  }

  return options;
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function command(
  commandName: string,
  httpMethod: string,
  scope: 'collection' | 'item',
  parameters?: Record<string, unknown>,
): ResourceCommand & { parameters?: Record<string, unknown> } {
  return {
    commandName,
    httpMethod,
    kind: 'crud',
    methodName: commandName,
    parameters,
    pathSegments: [],
    scope,
  };
}

function preferenceRuleResource(): CliResource {
  const preferenceRuleSchema = {
    additionalProperties: true,
    properties: {
      active: { type: 'boolean' },
      category: { type: 'string' },
      description: { type: 'string' },
      isHardFilter: { type: 'boolean' },
      name: { type: 'string' },
      ruleJson: { type: 'string' },
      weight: { type: 'number' },
    },
    type: 'object',
  };

  return {
    apiPath: 'preferencerules',
    className: 'PreferenceRule',
    commands: [
      command('list', 'GET', 'collection', {
        additionalProperties: false,
        properties: {
          limit: { type: 'integer' },
          offset: { type: 'integer' },
        },
        type: 'object',
      }),
      command('get', 'GET', 'item'),
      command('create', 'POST', 'collection', preferenceRuleSchema),
      command('update', 'PUT', 'item', preferenceRuleSchema),
      command('delete', 'DELETE', 'item'),
    ],
    label: 'Preference rules',
    slug: 'preferencerules',
  };
}

async function startFakeServer(): Promise<FakeServer> {
  const records = new Map<string, Record<string, unknown>>();
  let nextId = 1;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const auth = request.headers.authorization;
      if (url.pathname !== '/api/cli/auth/session') {
        assert(auth === 'Bearer smoke-token', 'CLI did not send bearer token.');
      }

      if (
        request.method === 'GET' &&
        url.pathname === '/api/cli/auth/session'
      ) {
        jsonResponse(response, 200, {
          authenticated: true,
          user: { id: 'smoke-user' },
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/_resources') {
        jsonResponse(response, 200, {
          resources: [preferenceRuleResource()],
          user: { authenticated: true },
          warnings: [],
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/mcp/tools') {
        jsonResponse(response, 200, {
          tools: [
            {
              description: 'List preference rules.',
              inputSchema: { type: 'object' },
              name: 'preferencerule_list',
            },
            {
              description: 'Bounded source and provider health.',
              inputSchema: {
                additionalProperties: false,
                properties: {
                  historyLimit: { maximum: 20, minimum: 1, type: 'integer' },
                  limit: { maximum: 25, minimum: 1, type: 'integer' },
                  query: { maxLength: 120, type: 'string' },
                },
                type: 'object',
              },
              name: 'job_search_list_source_health',
            },
            {
              description: 'Bounded source crawl status.',
              inputSchema: {
                anyOf: [{ required: ['crawlId'] }, { required: ['sourceId'] }],
                additionalProperties: false,
                properties: {
                  crawlId: { format: 'uuid', type: 'string' },
                  limit: { maximum: 20, minimum: 1, type: 'integer' },
                  sourceId: { format: 'uuid', type: 'string' },
                },
                type: 'object',
              },
              name: 'job_search_source_crawl_status',
            },
          ],
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/mcp/call') {
        const body = (await readJsonBody(request)) as Record<string, unknown>;
        if (body.name === 'job_search_list_source_health') {
          assert(
            JSON.stringify(body.arguments) ===
              JSON.stringify({
                historyLimit: 20,
                limit: 25,
                query: 'greenhouse',
              }),
            'CLI sent invalid source health arguments.',
          );
          jsonResponse(response, 200, {
            content: [
              {
                text: JSON.stringify({
                  items: [{ id: 'source-1', provider: 'greenhouse' }],
                  providers: [{ created: 3, provider: 'greenhouse' }],
                }),
                type: 'text',
              },
            ],
          });
          return;
        }
        if (body.name === 'job_search_source_crawl_status') {
          assert(
            JSON.stringify(body.arguments) ===
              JSON.stringify({
                limit: 20,
                sourceId: '11111111-1111-4111-8111-111111111111',
              }),
            'CLI sent invalid source crawl status arguments.',
          );
          jsonResponse(response, 200, {
            content: [
              {
                text: JSON.stringify({
                  items: [
                    {
                      errors: ['authorization=[redacted]'],
                      id: 'crawl-1',
                    },
                  ],
                  limit: 20,
                }),
                type: 'text',
              },
            ],
          });
          return;
        }
        assert(
          body.name === 'preferencerule_list',
          'CLI sent the wrong MCP tool name.',
        );
        jsonResponse(response, 200, {
          content: [
            {
              text: JSON.stringify({ count: records.size }),
              type: 'text',
            },
          ],
        });
        return;
      }

      if (url.pathname === '/api/preferencerules') {
        if (request.method === 'GET') {
          jsonResponse(response, 200, {
            count: records.size,
            items: Array.from(records.values()),
            limit: Number(url.searchParams.get('limit') ?? 50),
            offset: Number(url.searchParams.get('offset') ?? 0),
          });
          return;
        }

        if (request.method === 'POST') {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const id = `smoke-${nextId}`;
          nextId += 1;
          const record = { ...body, id };
          records.set(id, record);
          jsonResponse(response, 201, record);
          return;
        }
      }

      const itemMatch = url.pathname.match(/^\/api\/preferencerules\/([^/]+)$/);
      if (itemMatch) {
        const id = decodeURIComponent(itemMatch[1]);
        const found = records.get(id);
        if (!found) {
          jsonResponse(response, 404, { error: 'Item not found' });
          return;
        }

        if (request.method === 'GET') {
          jsonResponse(response, 200, found);
          return;
        }

        if (request.method === 'PUT') {
          const body = (await readJsonBody(request)) as Record<string, unknown>;
          const updated = { ...found, ...body, id };
          records.set(id, updated);
          jsonResponse(response, 200, updated);
          return;
        }

        if (request.method === 'DELETE') {
          records.delete(id);
          jsonResponse(response, 200, { success: true });
          return;
        }
      }

      jsonResponse(response, 404, { error: 'Not found' });
    } catch (error) {
      jsonResponse(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object', 'Fake server did not bind.');

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<RunResult> {
  const child = spawn('pnpm', ['exec', 'tsx', 'src/data-cli.ts', ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const [code] = (await once(child, 'close')) as [number];
  const result = {
    stderr: Buffer.concat(stderr).toString('utf8'),
    stdout: Buffer.concat(stdout).toString('utf8'),
  };
  if (code !== 0) {
    throw new Error(
      `CLI command failed: ${args.join(' ')}\n${result.stderr}${result.stdout}`,
    );
  }
  return result;
}

function parseJson<T>(result: RunResult): T {
  return JSON.parse(result.stdout) as T;
}

function findCommand(resource: CliResource, name: string): ResourceCommand {
  const found = resource.commands.find((item) => item.commandName === name);
  assert(found, `Missing ${name} command on ${resource.slug}.`);
  return found;
}

async function runSmoke(options: CliSmokeOptions) {
  let fakeServer: FakeServer | null = null;
  let cleanupCreatedPreferenceRule: (() => Promise<void>) | null = null;
  let cleanupError: unknown;
  let smokeError: unknown;
  let successMessage = '';
  const configDir = await mkdtemp(join(tmpdir(), 'iolaus-cli-smoke-'));

  try {
    try {
      if (!options.server) {
        fakeServer = await startFakeServer();
      }
      const server = options.server ?? fakeServer?.url;
      const token = options.server ? process.env.IOLAUS_TOKEN : 'smoke-token';
      assert(server, 'Smoke server URL was not resolved.');
      assert(token, 'A token is required when smoking a live server.');
      const env = Object.fromEntries([
        ['NO_COLOR', '1'],
        ['IOLAUS_CLI_CONFIG', join(configDir, 'config.json')],
        ['IOLAUS_SERVER_URL', server],
        ['IOLAUS_TOKEN', token],
        // Prove IOLAUS_* credentials and destination survive generic identity.
        ['SMRT_APP_ID', 'career-hub'],
      ]);

      const status = parseJson<{ authenticated: boolean }>(
        await runCli(['auth', 'status'], env),
      );
      assert(status.authenticated, 'auth status did not report authenticated.');

      const resources = parseJson<ResourceListResponse>(
        await runCli(['resources', '--json'], env),
      );
      const preferenceRules = resources.resources.find(
        (resource) => resource.className === 'PreferenceRule',
      );
      assert(preferenceRules, 'PreferenceRule resource was not discovered.');
      findCommand(preferenceRules, 'list');
      findCommand(preferenceRules, 'get');
      findCommand(preferenceRules, 'create');
      findCommand(preferenceRules, 'update');
      findCommand(preferenceRules, 'delete');

      await runCli([preferenceRules.slug, 'list', '{"limit":1}'], env);
      const created = parseJson<{ id?: string }>(
        await runCli(
          [
            preferenceRules.slug,
            'create',
            JSON.stringify({
              active: true,
              category: 'scoring',
              description: 'Created by CLI smoke.',
              isHardFilter: false,
              name: `CLI smoke ${Date.now()}`,
              ruleJson: '{}',
              weight: 0,
            }),
          ],
          env,
        ),
      );
      assert(created.id, 'create did not return an id.');
      cleanupCreatedPreferenceRule = async () => {
        await runCli(
          [preferenceRules.slug, 'delete', created.id as string],
          env,
        );
      };
      await runCli([preferenceRules.slug, 'get', created.id], env);
      const updated = parseJson<{ description?: string }>(
        await runCli(
          [
            preferenceRules.slug,
            'update',
            created.id,
            JSON.stringify({ description: 'Updated by CLI smoke.' }),
          ],
          env,
        ),
      );
      assert(
        updated.description === 'Updated by CLI smoke.',
        'update did not return the changed description.',
      );

      const toolsResponse = parseJson<RequestJsonResult<McpToolsResult>>(
        await runCli(['mcp', 'tools'], env),
      );
      assert(toolsResponse.ok, 'MCP tools returned a failed CLI result.');
      assert(
        toolsResponse.metadata.code === 'ok',
        'MCP tools result metadata was not successful.',
      );
      assert(
        Array.isArray(toolsResponse.result.tools),
        'MCP tools result did not contain a tools array.',
      );
      const listTool = toolsResponse.result.tools.find(
        (tool) =>
          tool.name.endsWith('_list') && tool.name.includes('preferencerule'),
      );
      assert(listTool, 'PreferenceRule MCP list tool was not discovered.');
      const callResponse = parseJson<RequestJsonResult<McpCallResult>>(
        await runCli(['mcp', 'call', listTool.name, '{}'], env),
      );
      assert(callResponse.ok, 'MCP call returned a failed CLI result.');
      assert(
        callResponse.metadata.code === 'ok',
        'MCP call result metadata was not successful.',
      );
      const callContent = callResponse.result.content.find(
        (entry) => entry.type === 'text' && entry.text,
      );
      assert(callContent?.text, 'MCP call did not return text content.');
      const callPayload = JSON.parse(callContent.text) as { count?: number };
      assert(
        callPayload.count === 1,
        'MCP call did not return the expected preference-rule count.',
      );

      const sourceHealthTool = toolsResponse.result.tools.find(
        (tool) => tool.name === 'job_search_list_source_health',
      );
      assert(sourceHealthTool, 'Source health MCP tool was not discovered.');
      assert(
        sourceHealthTool.inputSchema?.properties instanceof Object &&
          (
            sourceHealthTool.inputSchema.properties as Record<
              string,
              Record<string, unknown>
            >
          ).limit?.maximum === 25 &&
          (
            sourceHealthTool.inputSchema.properties as Record<
              string,
              Record<string, unknown>
            >
          ).historyLimit?.maximum === 20,
        'Source health MCP tool did not preserve bounded caps.',
      );
      const sourceHealthResponse = parseJson<RequestJsonResult<McpCallResult>>(
        await runCli(
          [
            'mcp',
            'call',
            sourceHealthTool.name,
            JSON.stringify({
              historyLimit: 20,
              limit: 25,
              query: 'greenhouse',
            }),
          ],
          env,
        ),
      );
      assert(sourceHealthResponse.ok, 'Source health MCP call failed.');

      const sourceCrawlStatusTool = toolsResponse.result.tools.find(
        (tool) => tool.name === 'job_search_source_crawl_status',
      );
      assert(
        sourceCrawlStatusTool,
        'Source crawl status MCP tool was not discovered.',
      );
      assert(
        Array.isArray(sourceCrawlStatusTool.inputSchema?.anyOf) &&
          (
            sourceCrawlStatusTool.inputSchema.properties as Record<
              string,
              Record<string, unknown>
            >
          ).limit?.maximum === 20,
        'Source crawl status MCP tool did not preserve selector and cap contracts.',
      );
      const sourceCrawlStatusResponse = parseJson<
        RequestJsonResult<McpCallResult>
      >(
        await runCli(
          [
            'mcp',
            'call',
            sourceCrawlStatusTool.name,
            JSON.stringify({
              limit: 20,
              sourceId: '11111111-1111-4111-8111-111111111111',
            }),
          ],
          env,
        ),
      );
      assert(
        sourceCrawlStatusResponse.ok,
        'Source crawl status MCP call failed.',
      );
      const sourceCrawlText =
        sourceCrawlStatusResponse.result.content.find(
          (entry) => entry.type === 'text' && entry.text,
        )?.text ?? '';
      assert(
        sourceCrawlText.includes('authorization=[redacted]') &&
          !sourceCrawlText.includes('super-secret'),
        'Source crawl status MCP call did not preserve sanitized errors.',
      );

      successMessage = `CLI smoke passed against ${
        fakeServer ? 'fake local API' : server
      }.`;
    } catch (error) {
      smokeError = error;
    }

    if (cleanupCreatedPreferenceRule) {
      try {
        await cleanupCreatedPreferenceRule();
      } catch (error) {
        if (smokeError) {
          console.warn(
            'CLI smoke cleanup failed after an earlier error:',
            error instanceof Error ? error.message : String(error),
          );
        } else {
          cleanupError = error;
        }
      }
    }
  } finally {
    await fakeServer?.close();
    await rm(configDir, { force: true, recursive: true });
  }

  if (smokeError) throw smokeError;
  if (cleanupError) throw cleanupError;
  console.log(successMessage);
}

assertCliServerSelection();
await runSmoke(parseOptions(process.argv.slice(2)));
