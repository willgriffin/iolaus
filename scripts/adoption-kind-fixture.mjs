import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  candidateRuntime,
  actorSecretData,
  syntheticAuthContract,
  requirePublishedPrerequisites,
} from './adoption-candidate.mjs';
import {
  resolveImages,
  resolvePublicPlatform,
  sha256,
  verifyPublicArtifacts,
} from './adoption-images.mjs';

export const fixtureIdentity = Object.freeze({
  applicationId: 'iolaus-qualification',
  databaseName: 'iolaus_qualification',
});
const qualificationStages = new Set([
  'preflight', 'public-artifacts', 'image-identity', 'toolchain', 'kind-create',
  'fixture-setup', 'fixture-postgres-pod', 'fixture-postgres-ready',
  'fixture-postgres-roles', 'fixture-postgres-schema', 'fixture-assets',
  'fixture-service-accounts', 'fixture-observer', 'fixture-maintenance-render',
  'fixture-maintenance-ready', 'fixture-actor-secrets',
  'missing-schema-refusal', 'writer-refusal', 'clean-migration',
  'runtime-readiness', 'http-and-operator', 'worker-and-monitor',
  'runtime-readiness-web', 'runtime-readiness-task',
  'runtime-readiness-schedule', 'runtime-readiness-extractor',
  'worker-sigterm-task', 'worker-sigterm-schedule', 'monitor-check',
  'source-and-extractor', 'evidence', 'cleanup-started', 'cleanup-completed',
]);
let activeQualificationStage = 'preflight';
export function qualificationStageMessage(stage) {
  assert.ok(qualificationStages.has(stage), 'Unknown qualification stage.');
  return `[adoption] ${stage}`;
}
function checkpoint(stage) {
  const message = qualificationStageMessage(stage);
  activeQualificationStage = stage;
  console.log(message);
}

// Keep failure diagnostics useful without printing Pod specs, messages or logs.
export function runtimePodDiagnostics(pods) {
  const phases = new Set(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']);
  const reasons = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull',
    'CreateContainerConfigError', 'CreateContainerError', 'ContainerCreating',
    'OOMKilled', 'Error', 'Completed']);
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return pods.slice(0, 8).map((pod) => ({
    phase: phases.has(pod.status?.phase) ? pod.status.phase : 'Unknown',
    scheduled: pod.status?.conditions?.some((c) => c.type === 'PodScheduled' && c.status === 'True') === true,
    containers: (pod.status?.containerStatuses ?? []).slice(0, 8).map((c) => {
      const state = c.state?.waiting ?? c.state?.terminated;
      return {
        ready: c.ready === true,
        restarts: number(c.restartCount),
        state: reasons.has(state?.reason) ? state.reason : c.state?.running ? 'Running' : 'Unknown',
        exitCode: number(c.state?.terminated?.exitCode),
      };
    }),
  }));
}

export function runtimeLogCategories(log) {
  return [
    ['schema-not-ready', /Deployment schema is not ready:/i],
    ['permission-denied', /permission denied|must be owner/i],
    ['auth-not-ready', /authentication provider is not ready/i],
    ['storage-mentioned', /HeadBucket|S3|storage is not ready/i],
    ['read-only-filesystem', /EACCES|EROFS|read-only file system/i],
    ['module-not-found', /MODULE_NOT_FOUND|Cannot find module/i],
    ['out-of-memory', /heap out of memory|allocation failed/i],
    ['connection-refused', /ECONNREFUSED|connection refused/i],
    ['runtime-configuration', /Unable to load SMRT runtime configuration|configuration.*required/i],
    ['database-schema-error', /relation .* does not exist|column .* does not exist/i],
    ['component-database', /component=database\b/],
    ['component-authentication', /component=authentication\b/],
    ['component-assets', /component=assets\b/],
    ['component-secrets', /component=secrets\b/],
    ['invalid-configuration', /code=invalid_configuration\b/],
    ['provider-mismatch', /code=provider_mismatch\b/],
    ['provider-unavailable', /code=provider_unavailable\b/],
  ].filter(([, pattern]) => pattern.test(log)).map(([category]) => category);
}

// Only this disposable fixture receives the workflow's temporary read token.
// The returned objects are sent to the fresh API on stdin, never to a file/log.
export function qualificationRegistryPullSecrets(environment) {
  const actor = environment.IOLAUS_QUALIFICATION_REGISTRY_ACTOR;
  const token = environment.IOLAUS_QUALIFICATION_REGISTRY_TOKEN;
  if (actor === undefined && token === undefined) return [];
  assert.ok(typeof actor === 'string' && /^[\w-]+(?:\[bot\])?$/.test(actor),
    'Complete ephemeral registry pull identity required.');
  assert.ok(typeof token === 'string' && token.length > 0 && !/[\r\n]/.test(token),
    'Complete ephemeral registry pull identity required.');
  const config = JSON.stringify({ auths: { 'ghcr.io': {
    auth: Buffer.from(`${actor}:${token}`).toString('base64'),
  } } });
  return ['iolaus-fixture', fixtureIdentity.applicationId].map((namespace) => ({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'iolaus-qualification-registry', namespace },
    type: 'kubernetes.io/dockerconfigjson', immutable: true,
    data: { '.dockerconfigjson': Buffer.from(config).toString('base64') },
  }));
}

export function assertRegistryPullIsolation(pod, secretName, needsPull = true) {
  assert.deepEqual(pod.spec.imagePullSecrets?.map(({ name }) => name) ?? [],
    needsPull ? [secretName] : []);
  for (const container of [...pod.spec.containers, ...(pod.spec.initContainers ?? [])]) {
    assert.ok(!(container.env ?? []).some((entry) =>
      entry.valueFrom?.secretKeyRef?.name === secretName ||
      ['GITHUB_TOKEN', 'IOLAUS_QUALIFICATION_REGISTRY_TOKEN'].includes(entry.name)),
    'Registry pull credentials must not enter container environment.');
    assert.ok(!(container.envFrom ?? []).some((entry) => entry.secretRef?.name === secretName),
      'Registry pull credentials must not enter container environment.');
  }
  assert.ok(!(pod.spec.volumes ?? []).some((volume) =>
    volume.secret?.secretName === secretName ||
    volume.projected?.sources?.some((source) => source.secret?.name === secretName)),
  'Registry pull credentials must not be mounted into containers.');
}
export function fixtureDatabaseUrl(role, password) {
  assert.match(role, /^iolaus_(maintenance|runtime|monitor)$/);
  assert.match(password, /^[a-f0-9]{48}$/);
  return `postgresql://${role}:${password}@postgres.iolaus-fixture.svc.cluster.local:5432/${fixtureIdentity.databaseName}`;
}
export function fixtureDatabaseSql(statement) {
  return `\\connect ${fixtureIdentity.databaseName}\n${statement}\n`;
}

export function syntheticRuntimeValues(password) {
  return {
    SMRT_RUNTIME_PROFILE: 'self-hosted',
    IOLAUS_DEPLOYMENT_PROTOCOL: 'smrt-release-v1',
    SMRT_APP_ID: fixtureIdentity.applicationId,
    NODE_ENV: 'production',
    HOME: '/tmp',
    XDG_CACHE_HOME: '/tmp/.cache',
    IOLAUS_AUTH_MODE: 'magic-link',
    IOLAUS_WORKSPACE_MODE: 'shared',
    IOLAUS_OIDC_ADMIN_EMAILS: 'operator@example.invalid',
    IOLAUS_PUBLIC_URL: 'https://iolaus.example.invalid',
    ADDRESS_HEADER: 'x-forwarded-for',
    IOLAUS_MAGIC_LINK_SECRET: randomBytes(32).toString('hex'),
    SMTP_HOST: 'smtp.example.invalid',
    SMTP_USER: 'fixture',
    SMTP_PASSWORD: password,
    SMTP_FROM: 'fixture@example.invalid',
    RESUME_FILES_CONFIG_JSON: JSON.stringify({
      type: 's3',
      endpoint: 'http://assets.iolaus-fixture.svc.cluster.local:8080',
      region: 'fixture',
      bucket: 'assets',
      accessKeyId: 'fixture',
      secretAccessKey: password,
      forcePathStyle: true,
    }),
    HOST: '0.0.0.0',
    PORT: '3000',
    BODY_SIZE_LIMIT: '10551296',
    IOLAUS_RESUME_EXTRACTION_URL: `http://iolaus-extractor.${fixtureIdentity.applicationId}.svc.cluster.local:8080`,
    HAVE_PDF_PADDLEOCR_URL: 'http://ocr.example.invalid',
    SMRT_WORKER_HEARTBEAT_FILE: '/tmp/worker-heartbeat.json',
    SMRT_WORKER_HEARTBEAT_MAX_AGE_MS: '45000',
    SMRT_WORKER_CONCURRENCY: '4',
    SMRT_JOBS_WORKER_CONCURRENCY: '4',
    SMRT_JOBS_WORKER_SHUTDOWN_MS: '240000',
  };
}

export function requireIsolatedContext(context, namespace) {
  assert.match(context, /^kind-iolaus-236-[a-z0-9-]+$/);
  assert.equal(namespace, 'iolaus-qualification');
}
export function qualificationApplyArguments(kubeconfig, context, namespace, rendered) {
  requireIsolatedContext(context, namespace);
  return [
    '--kubeconfig', kubeconfig, '--context', context,
    // Helm's --namespace does not inject metadata.namespace into templates.
    // Explicit JSON fixture lists span both synthetic namespaces instead.
    ...(rendered ? ['--namespace', namespace] : []),
    'apply', '-f', '-',
  ];
}
export function terminalJobFailure(job) {
  return (
    (job.status?.failed ?? 0) > 0 &&
    (job.status?.active ?? 0) === 0 &&
    job.status?.conditions?.some(
      (condition) => condition.type === 'Failed' && condition.status === 'True',
    ) === true
  );
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(description, check, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error(`Qualification timed out: ${description}`);
}

// This fixture is synthetic and disposable. Never loads a default kubeconfig,
// accepts production namespaces, or emits credential-bearing child stderr.
export async function qualifyKind({
  prerequisites,
  runnerRoot,
  chartFile,
  images,
  output,
}) {
  checkpoint('preflight');
  requirePublishedPrerequisites(prerequisites);
  for (const name of ['postgresImage', 'kindNodeImage', 'maintenanceImage']) {
    assert.match(
      prerequisites.fixture?.[name] ?? '',
      /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/,
      `Pinned ${name} required.`,
    );
  }
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  const registrySecrets = qualificationRegistryPullSecrets(process.env);
  delete process.env.IOLAUS_QUALIFICATION_REGISTRY_TOKEN;
  delete process.env.IOLAUS_QUALIFICATION_REGISTRY_ACTOR;
  const imagePullSecrets = registrySecrets.length
    ? [{ name: registrySecrets[0].metadata.name }] : [];
  const run = (binary, args, input) => {
    try {
      return execFileSync(binary, args, {
        input,
        encoding: 'utf8',
        timeout: 360_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(
        `Qualification command failed: ${binary.split('/').at(-1)} ${args[0]}`,
      );
    }
  };
  checkpoint('public-artifacts');
  const shared = await verifyPublicArtifacts({
    prerequisites,
    runnerRoot,
    chartFile,
    run: (binary, args, options) => execFileSync(binary, args, options),
  });
  const root = resolve('.');
  const originalPath = process.env.PATH;
  assert.equal(
    run('git', ['status', '--porcelain', '--untracked-files=all']).trim(),
    '',
    'Qualification requires committed clean application source.',
  );
  const source = run('git', ['rev-parse', 'HEAD']).trim();
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']).trim();
  const lock = sha256(readFileSync('pnpm-lock.yaml'));
  checkpoint('image-identity');
  const resolvedImages = resolveImages(images, source, lock);
  prerequisites = structuredClone(prerequisites);
  for (const name of ['postgresImage', 'kindNodeImage', 'maintenanceImage'])
    prerequisites.fixture[name] = resolvePublicPlatform(
      prerequisites.fixture[name],
    ).platform;
  const runtime = candidateRuntime(resolvedImages, syntheticAuthContract);
  shared.validateRuntime(runtime);
  const scratch = mkdtempSync(join(tmpdir(), 'iolaus-adoption-'));
  const name = `iolaus-236-${randomBytes(4).toString('hex')}`;
  const context = `kind-${name}`;
  const namespace = 'iolaus-qualification';
  requireIsolatedContext(context, namespace);
  const kubeconfig = join(scratch, 'kubeconfig');
  checkpoint('toolchain');
  const toolchain = await import(
    pathToFileURL(join(runnerRoot, 'scripts/deployment-toolchain.mjs'))
  );
  const tools = {};
  for (const tool of ['kind', 'helm', 'kubectl'])
    tools[tool] = await toolchain.installDeploymentTool(
      tool,
      join(scratch, 'bin'),
    );
  process.env.PATH = `${join(scratch, 'bin')}:${process.env.PATH}`;
  const kubectl = (...args) =>
    run(tools.kubectl, [
      '--kubeconfig',
      kubeconfig,
      '--context',
      context,
      ...args,
    ]);
  const apply = (objects) =>
    run(
      tools.kubectl,
      qualificationApplyArguments(kubeconfig, context, namespace,
        typeof objects === 'string'),
      typeof objects === 'string'
        ? objects
        : JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }),
    );
  const get = (kind, object, ns = namespace) =>
    JSON.parse(kubectl('-n', ns, 'get', kind, object, '-o', 'json'));
  const checks = [];
  const labels = { 'iolaus.happyvertical.com/qualification': 'synthetic-only' };
  let created = false;
  try {
    assert.ok(
      !run(tools.kind, ['get', 'clusters']).trim().split(/\s+/).includes(name),
    );
    created = true;
    checkpoint('kind-create');
    run(tools.kind, [
      'create',
      'cluster',
      '--name',
      name,
      '--image',
      prerequisites.fixture.kindNodeImage,
      '--kubeconfig',
      kubeconfig,
      '--wait',
      '120s',
    ]);
    assert.equal(kubectl('config', 'current-context').trim(), context);
    apply(
      ['iolaus-fixture', namespace].map((value) => ({
        apiVersion: 'v1',
        kind: 'Namespace',
        metadata: { name: value, labels },
      })),
    );
    assert.equal(
      get('namespace', namespace, namespace).metadata.labels[
        'iolaus.happyvertical.com/qualification'
      ],
      'synthetic-only',
    );
    checkpoint('fixture-setup');
    if (registrySecrets.length) {
      apply(registrySecrets);
    }
    checkpoint('fixture-postgres-pod');
    const password = randomBytes(24).toString('hex');
    const fixturePod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'postgres', namespace: 'iolaus-fixture', labels },
      spec: {
        automountServiceAccountToken: false,
        containers: [
          {
            name: 'postgres',
            image: prerequisites.fixture.postgresImage,
            env: [{ name: 'POSTGRES_PASSWORD', value: password }],
            readinessProbe: {
              // The image bootstraps a temporary Unix-only server first.
              // Only the final TCP listener can serve application clients.
              exec: { command: ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres'] },
            },
            ports: [{ containerPort: 5432 }],
          },
        ],
      },
    };
    const service = (name, port) => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: 'iolaus-fixture' },
      spec: { selector: { app: name }, ports: [{ port, targetPort: port }] },
    });
    fixturePod.metadata.labels.app = 'postgres';
    apply([fixturePod, service('postgres', 5432)]);
    checkpoint('fixture-postgres-ready');
    kubectl(
      '-n',
      'iolaus-fixture',
      'wait',
      '--for=condition=Ready',
      'pod/postgres',
      '--timeout=120s',
    );
    const sql = (statement) =>
      run(
        tools.kubectl,
        [
          '--kubeconfig',
          kubeconfig,
          '--context',
          context,
          '-n',
          'iolaus-fixture',
          'exec',
          '-i',
          'postgres',
          '--',
          'psql',
          '-U',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-At',
        ],
        statement,
      );
    checkpoint('fixture-postgres-roles');
    sql(
      `CREATE ROLE iolaus_maintenance LOGIN PASSWORD '${password}';\nCREATE ROLE iolaus_runtime LOGIN PASSWORD '${password}';\nCREATE ROLE iolaus_monitor LOGIN PASSWORD '${password}';\nCREATE DATABASE ${fixtureIdentity.databaseName} OWNER iolaus_maintenance;\n`,
    );
    checkpoint('fixture-postgres-schema');
    sql(fixtureDatabaseSql('REVOKE CREATE ON SCHEMA public FROM PUBLIC;'));
    checkpoint('fixture-assets');
    // Real HTTP HeadBucket edge, no readiness override module or passed flag.
    // This endpoint is a synthetic fixture, not qualification of an S3 vendor.
    const assetCode =
      "require('node:http').createServer((req,res)=>{if(req.method==='HEAD'&&['/assets/','/assets'].includes(req.url)){res.writeHead(200);res.end();}else{res.writeHead(404);res.end();}}).listen(8080,'0.0.0.0')";
    apply([
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: 'assets',
          namespace: 'iolaus-fixture',
          labels: { app: 'assets' },
        },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets,
          containers: [
            {
              name: 'assets',
              image: resolvedImages.site,
              command: ['node', '-e', assetCode],
            },
          ],
        },
      },
      service('assets', 8080),
    ]);
    const databaseUrl = (role) => fixtureDatabaseUrl(role, password);
    const values = syntheticRuntimeValues(password);
    checkpoint('fixture-service-accounts');
    apply(
      ['iolaus-runtime', 'iolaus-monitor', 'iolaus-migration-observer'].map(
        (sa) => ({
          apiVersion: 'v1',
          kind: 'ServiceAccount',
          metadata: { name: sa, namespace },
          automountServiceAccountToken: false,
          imagePullSecrets,
        }),
      ),
    );
    checkpoint('fixture-observer');
    apply([
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: 'observer', namespace },
        rules: [
          { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
          {
            apiGroups: [''],
            resources: ['configmaps'],
            resourceNames: ['iolaus-maintenance'],
            verbs: ['get'],
          },
          {
            apiGroups: ['apps'],
            resources: [
              'deployments',
              'replicasets',
              'statefulsets',
              'daemonsets',
            ],
            verbs: ['get', 'list'],
          },
          {
            apiGroups: ['batch'],
            resources: ['jobs', 'cronjobs'],
            verbs: ['get', 'list'],
          },
          {
            apiGroups: ['autoscaling'],
            resources: ['horizontalpodautoscalers'],
            verbs: ['get', 'list'],
          },
        ],
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: 'observer', namespace },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: 'observer',
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'iolaus-migration-observer',
            namespace,
          },
        ],
      },
    ]);
    const release = {
      release: {
        id: 'qualification',
        phase: 'migrate',
        sequence: 0,
        attempt: 1,
      },
      app: { name: 'iolaus', environment: 'qualification' },
      current: false,
      target: runtime,
      maintenance: {
        image: prerequisites.fixture.maintenanceImage,
        command: ['nginx', '-g', 'daemon off;'],
        port: 8080,
        http: { path: '/', status: 503, body: 'Maintenance' },
      },
      bindings: {
        database: {
          secretName: 'iolaus-runtime-v1',
          secretKey: 'DATABASE_URL',
        },
        privateBuckets: [
          {
            name: 'assets',
            secretName: 'iolaus-runtime-v1',
            secretKey: 'RESUME_FILES_CONFIG_JSON',
          },
        ],
      },
      ingress: { host: 'iolaus.example.invalid', className: 'nginx' },
    };
    const render = (only) => {
      const file = join(scratch, 'values.json');
      writeFileSync(file, JSON.stringify(release));
      return run(tools.helm, [
        'template',
        'iolaus',
        chartFile,
        '--namespace',
        namespace,
        '-f',
        file,
        ...(only ? ['--show-only', only] : []),
      ]);
    };
    checkpoint('fixture-maintenance-render');
    apply(render('templates/maintenance.yaml'));
    checkpoint('fixture-maintenance-ready');
    kubectl(
      '-n',
      namespace,
      'rollout',
      'status',
      'deployment/iolaus-maintenance',
      '--timeout=120s',
    );
    values.IOLAUS_MAINTENANCE_OBSERVER_POLICY = JSON.stringify({
      releaseName: 'iolaus',
      image: prerequisites.fixture.maintenanceImage,
      configSha256: sha256(
        get('configmap', 'iolaus-maintenance').data['default.conf'],
      ),
      serviceAccountName: 'default',
      migrationServiceAccountName: 'iolaus-migration-observer',
    });
    checkpoint('fixture-actor-secrets');
    apply(
      ['runtime', 'migration', 'monitor'].map((role) => ({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: `iolaus-${role}-v1`, namespace },
        immutable: true,
        stringData: actorSecretData(
          runtime,
          {
            ...values,
            DATABASE_URL: databaseUrl(
              role === 'migration' ? 'iolaus_maintenance' : `iolaus_${role}`,
            ),
          },
          role,
        ),
      })),
    );
    checkpoint('missing-schema-refusal');
    apply([
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'missing-schema', namespace },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          serviceAccountName: 'iolaus-runtime',
          securityContext: runtime.workloads.task.podSecurityContext,
          containers: [
            {
              name: 'runtime',
              image: resolvedImages.site,
              command: runtime.workloads.task.command,
              env: runtime.workloads.task.env,
              securityContext: runtime.workloads.task.securityContext,
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [{ name: 'tmp', emptyDir: { sizeLimit: '1Gi' } }],
        },
      },
    ]);
    await until(
      'runtime missing schema refusal',
      () => get('pod', 'missing-schema').status.phase === 'Failed',
    );
    assert.match(
      kubectl('-n', namespace, 'logs', 'missing-schema'),
      /Deployment schema is not ready:/,
    );
    kubectl(
      '-n',
      namespace,
      'delete',
      'pod',
      'missing-schema',
      '--wait=true',
      '--timeout=60s',
    );
    checks.push('actual-runtime-missing-schema-refusal-without-ddl');
    // An unrelated active Pod must prevent schema/ledger creation.
    checkpoint('writer-refusal');
    apply([
      {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'unknown-writer', namespace },
        spec: {
          automountServiceAccountToken: false,
          imagePullSecrets,
          containers: [
            {
              name: 'writer',
              image: resolvedImages.site,
              command: ['node', '-e', 'setInterval(()=>{},1000)'],
            },
          ],
        },
      },
    ]);
    const before = sql(
      fixtureDatabaseSql(
        "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
      ),
    ).trim();
    apply(render());
    const jobName = () =>
      `iolaus-migration-qualification-${release.release.attempt}`;
    await until('unknown writer refusal', () =>
      terminalJobFailure(get('job', jobName())),
    );
    assert.equal(
      sql(
        fixtureDatabaseSql(
          "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
        ),
      ).trim(),
      before,
      'Refusal must happen before schema or ledger writes.',
    );
    assert.match(
      kubectl('-n', namespace, 'logs', `job/${jobName()}`),
      /Unknown workload|Active or unknown writer/,
    );
    checks.push('actual-wrapper-unknown-writer-refusal-before-write');
    kubectl(
      '-n',
      namespace,
      'delete',
      'pod',
      'unknown-writer',
      '--wait=true',
      '--timeout=60s',
    );
    checkpoint('clean-migration');
    release.release.attempt = 2;
    apply(render());
    await until(
      'actual wrapper clean bootstrap',
      () => get('job', jobName()).status?.succeeded === 1,
      300_000,
    );
    checks.push('actual-wrapper-projected-observer-bootstrap');
    sql(
      fixtureDatabaseSql(
        `GRANT CONNECT ON DATABASE ${fixtureIdentity.databaseName} TO iolaus_runtime, iolaus_monitor;\nGRANT USAGE ON SCHEMA public TO iolaus_runtime, iolaus_monitor;\nGRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO iolaus_runtime;\nGRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO iolaus_runtime;\nGRANT SELECT (status,finished_at,started_at) ON source_crawls TO iolaus_monitor;\nGRANT SELECT (queue,status) ON _smrt_jobs TO iolaus_monitor;\n`,
      ),
    );
    checkpoint('runtime-readiness');
    release.release.phase = 'verify';
    release.release.sequence++;
    apply(render());
    try {
      for (const name of ['web', 'task', 'schedule', 'extractor']) {
        checkpoint(`runtime-readiness-${name}`);
        kubectl('-n', namespace, 'rollout', 'status',
          `deployment/iolaus-${name}`, '--timeout=180s');
      }
    } catch (error) {
      for (const name of ['web', 'task', 'schedule', 'extractor']) {
        try {
          const pods = JSON.parse(kubectl('--request-timeout=10s', '-n', namespace, 'get', 'pods', '-l',
            `app.kubernetes.io/instance=iolaus,smrt.happyvertical.com/workload=${name}`,
            '-o', 'json')).items;
          console.log(`[adoption] runtime-status ${JSON.stringify({ workload: name,
            pods: runtimePodDiagnostics(pods) })}`);
          for (const pod of pods.slice(0, 2)) {
            if (!/^iolaus-(web|task|schedule|extractor)-[a-z0-9-]+$/.test(pod.metadata.name)) continue;
            const logs = kubectl('--request-timeout=10s', '-n', namespace, 'logs', pod.metadata.name, '--tail=80');
            console.log(`[adoption] runtime-log-categories ${JSON.stringify({
              workload: name, categories: runtimeLogCategories(logs) })}`);
          }
        } catch {
          console.log(`[adoption] runtime-diagnostics-unavailable ${name}`);
        }
      }
      throw error;
    }
    for (const name of ['web', 'task', 'schedule', 'extractor']) {
      const pods = JSON.parse(
        kubectl(
          '-n',
          namespace,
          'get',
          'pods',
          '-l',
          `app.kubernetes.io/instance=iolaus,smrt.happyvertical.com/workload=${name}`,
          '-o',
          'json',
        ),
      ).items;
      assert.ok(pods.length > 0, 'Expected actual workload Pod.');
      for (const pod of pods)
        assert.equal(
          pod.status.containerStatuses[0].imageID.split('@').at(-1),
          runtime.workloads[name].image.split('@')[1],
        );
    }
    if (registrySecrets.length) {
      for (const ns of ['iolaus-fixture', namespace]) {
        const pods = JSON.parse(kubectl('-n', ns, 'get', 'pods', '-o', 'json')).items;
        for (const pod of pods) {
          const needsPull = pod.spec.containers.some(({ image }) =>
            Object.values(resolvedImages).includes(image));
          assertRegistryPullIsolation(pod, registrySecrets[0].metadata.name, needsPull);
        }
      }
      checks.push('ephemeral-read-only-registry-pull-without-container-credential-projection');
    }
    checkpoint('http-and-operator');
    const webPod = get('deployment', 'iolaus-web').spec.selector.matchLabels;
    const selector = Object.entries(webPod)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const pod = JSON.parse(
      kubectl('-n', namespace, 'get', 'pods', '-l', selector, '-o', 'json'),
    ).items.find((entry) => entry.status.phase === 'Running').metadata.name;
    const http = String.raw`(async()=>{const a=require('node:assert/strict');for(const [path,status,method] of [['/',200,'GET'],['/live',200,'GET'],['/health',200,'GET'],['/api/job-search/browse',401,'POST']]){const r=await fetch('http://127.0.0.1:3000'+path,{method,redirect:'manual',headers:{'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});a.equal(r.status,status,path);a.notEqual(r.status,500);} })().catch(()=>process.exit(1))`;
    kubectl('-n', namespace, 'exec', pod, '--', 'node', '-e', http);
    checks.push('actual-image-http-positive-private-denial-no-500');
    const taskSelector = Object.entries(
      get('deployment', 'iolaus-task').spec.selector.matchLabels,
    ).map(([key, value]) => `${key}=${value}`).join(',');
    const taskPod = JSON.parse(kubectl(
      '-n', namespace, 'get', 'pods', '-l', taskSelector, '-o', 'json',
    )).items.find((entry) => entry.status.phase === 'Running').metadata.name;
    const operator = String.raw`
      import assert from 'node:assert/strict';
      import { withTenant } from '@happyvertical/smrt-tenancy';
      import { requireSourceCrawlOperator } from './src/lib/server/source-crawl-operator.ts';
      assert.equal(process.env.IOLAUS_OIDC_ADMIN_EMAILS, 'operator@example.invalid');
      await withTenant({tenantId:'fixture-tenant', userId:'fixture-operator',
        user:{id:'fixture-operator',email:'operator@example.invalid',status:'active'}}, async()=>{
        assert.doesNotThrow(()=>requireSourceCrawlOperator());
        process.env.IOLAUS_OIDC_ADMIN_EMAILS='revoked@example.invalid';
        assert.throws(()=>requireSourceCrawlOperator(), /active installation operator/);
      });
      await withTenant({tenantId:'fixture-tenant', userId:'fixture-member',
        user:{id:'fixture-member',email:'member@example.invalid',status:'active'}}, async()=>{
        assert.throws(()=>requireSourceCrawlOperator(), /active installation operator/);
      });
    `;
    kubectl('-n', namespace, 'exec', taskPod, '--', 'sh', '-c',
      'cd /app/apps/site && exec node --import tsx --input-type=module -e "$1"',
      'iolaus-operator-probe', operator);
    checks.push('actual-image-shared-operator-projection-and-allowlist-revalidation');
    // SIGTERM must produce a clean exit after the actual worker started.
    // This idle-queue scenario does not claim inflight provider cancellation.
    checkpoint('worker-and-monitor');
    for (const name of ['task', 'schedule']) {
      checkpoint(`worker-sigterm-${name}`);
      const deployment = get('deployment', `iolaus-${name}`);
      const selection = Object.entries(deployment.spec.selector.matchLabels)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
      const worker = JSON.parse(
        kubectl('-n', namespace, 'get', 'pods', '-l', selection, '-o', 'json'),
      ).items.find((entry) => entry.status.phase === 'Running');
      const originalRestarts = worker.status.containerStatuses[0].restartCount;
      kubectl(
        '-n',
        namespace,
        'exec',
        worker.metadata.name,
        '--',
        'node',
        '-e',
        "process.kill(1,'SIGTERM')",
      );
      await until(
        `${name} SIGTERM clean exit`,
        () => {
          const status = get('pod', worker.metadata.name).status
            .containerStatuses[0];
          if (status.restartCount <= originalRestarts) return false;
          assert.equal(status.lastState.terminated.exitCode, 0);
          return status.ready === true;
        },
        270_000,
      );
    }
    checks.push('actual-worker-start-idle-sigterm-clean-exit-and-restart');
    checkpoint('monitor-check');
    try {
      kubectl(
        '-n',
        namespace,
        'create',
        'job',
        'monitor-check',
        '--from=cronjob/iolaus-monitor',
      );
      kubectl(
        '-n',
        namespace,
        'wait',
        '--for=condition=complete',
        'job/monitor-check',
        '--timeout=90s',
      );
    } catch (error) {
      try {
        const pods = JSON.parse(kubectl('--request-timeout=10s', '-n', namespace,
          'get', 'pods', '-l', 'job-name=monitor-check', '-o', 'json')).items;
        console.log(`[adoption] runtime-status ${JSON.stringify({ workload: 'monitor',
          pods: runtimePodDiagnostics(pods) })}`);
        for (const pod of pods.slice(0, 2)) {
          if (!/^monitor-check-[a-z0-9-]+$/.test(pod.metadata.name)) continue;
          const logs = kubectl('--request-timeout=10s', '-n', namespace,
            'logs', pod.metadata.name, '--tail=80');
          console.log(`[adoption] runtime-log-categories ${JSON.stringify({
            workload: 'monitor', categories: runtimeLogCategories(logs) })}`);
        }
      } catch {
        console.log('[adoption] runtime-diagnostics-unavailable monitor');
      }
      throw error;
    }
    checks.push('actual-monitor-with-column-restricted-database-role');
    checkpoint('source-and-extractor');
    const parityFile = join(scratch, 'parity.json');
    run('node', [
      'scripts/deployed-parity.mjs',
      '--image-ref',
      resolvedImages.site,
      '--evidence',
      parityFile,
    ]);
    const parity = JSON.parse(readFileSync(parityFile));
    assert.equal(parity.status, 'passed');
    assert.equal(parity.candidateImageTested, true);
    assert.equal(
      parity.candidateImageProvenance.sourceTreeSha256,
      parity.sourceTreeSha256,
    );
    run('node', [
      'scripts/resume-extractor-candidate.mjs',
      resolvedImages.extractor,
      source,
      lock,
    ]);
    checks.push(
      'existing-source-byte-parity-and-extractor-real-image-envelope',
    );
    // This receipt covers the executed synthetic qualification. No promotion or
    // GitOps command is called, and provider-vendor effects remain unqualified.
    const evidence = {
      source,
      tree,
      lock,
      toolchain: sha256(
        JSON.stringify({
          node: process.version,
          tools: toolchain.deploymentTools,
        }),
      ),
      runtimeIdentity: shared.hash(runtime),
      migrationImage: runtime.migration.image,
      migrationCommandIdentity: shared.hash(runtime.migration.command),
      migrationProtocol: 'smrt-release-v1',
      chartArtifactSha256: prerequisites.chart.packageSha256,
      chartOciDigest: prerequisites.chart.ociDigest,
      chartReferenceIdentity: shared.hash({
        kind: 'OCIRepository',
        name: 'smrt-app',
        namespace: 'flux-system',
      }),
      chartSourceIdentity: shared.hash({
        interval: '1m',
        url: prerequisites.chart.reference,
        ref: { digest: prerequisites.chart.ociDigest },
      }),
      configurationIdentity: shared.hash({
        maintenance: release.maintenance,
        bindings: release.bindings,
        ingress: release.ingress,
      }),
      validation: { passed: true },
      checks,
      images: resolvedImages,
      fixtures: prerequisites.fixture,
      rollout: 'held',
      scope: 'synthetic-kind-image-qualification',
      providerVendorEffectsQualified: false,
    };
    checkpoint('evidence');
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
    });
    return evidence;
  } finally {
    console.log(qualificationStageMessage('cleanup-started'));
    try {
      if (created) run(tools.kind, ['delete', 'cluster', '--name', name]);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
      process.env.PATH = originalPath;
      process.chdir(root);
    }
    console.log(qualificationStageMessage('cleanup-completed'));
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [prerequisites, runnerRoot, chartFile, images, output] =
    process.argv.slice(2);
  qualifyKind({
    prerequisites: JSON.parse(readFileSync(prerequisites)),
    runnerRoot,
    chartFile,
    images: JSON.parse(readFileSync(images)),
    output,
  })
    .then((evidence) =>
      console.log(
        JSON.stringify({
          scope: evidence.scope,
          checks: evidence.checks,
          rollout: evidence.rollout,
        }),
      ),
    )
    .catch(() => {
      console.error(
        `Iolaus synthetic adoption qualification failed at ${activeQualificationStage}; no success receipt is authorized.`,
      );
      process.exitCode = 1;
    });
}
