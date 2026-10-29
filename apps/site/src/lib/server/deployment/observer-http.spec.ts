import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ readFile: vi.fn(), request: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: native.readFile }));
vi.mock('node:https', () => ({ request: native.request }));

import {
  type ContinuousStaticWorkload,
  canonical,
  expectedPodEnvelope,
} from './continuous-static.js';
import {
  observeWriterExclusion,
  waitForWriterFenceEnrollment,
} from './observer.js';
import type { WriterFenceLeasePolicy } from './writer-fence.js';

const projection = '/var/run/secrets/kubernetes.io/serviceaccount';
const identity = {
  application: 'iolaus',
  environment: 'test',
  release: 'r1',
  attempt: '1',
};
const ca =
  '-----BEGIN CERTIFICATE-----\nprojected-ca\n-----END CERTIFICATE-----';

function rawInventory() {
  const labels = {
    'app.kubernetes.io/instance': 'site',
    'app.kubernetes.io/name': 'iolaus',
    'smrt.happyvertical.com/environment': 'test',
    'smrt.happyvertical.com/release': 'r1',
    'smrt.happyvertical.com/phase': 'migrate',
  };
  const metadata = (name: string, uid: string) => ({
    name,
    uid,
    namespace: 'test',
    labels,
  });
  const spec = {
    automountServiceAccountToken: false,
    serviceAccountName: 'default',
    containers: [
      {
        image: `nginx@sha256:${'1'.repeat(64)}`,
        command: ['nginx', '-g', 'daemon off;'],
        volumeMounts: [
          { name: 'config', mountPath: '/etc/nginx/conf.d', readOnly: true },
        ],
      },
    ],
    volumes: [{ name: 'config', configMap: { name: 'site-maintenance' } }],
  };
  const config = 'server { listen 8080; return 503; }\n';
  const pod = {
    metadata: {
      ...metadata('migrator', 'pod-1'),
      labels: {
        ...labels,
        'smrt.happyvertical.com/component': 'migration',
        'smrt.happyvertical.com/attempt': '1',
      },
      ownerReferences: [
        {
          kind: 'Job',
          name: 'site-migration-r1-1',
          uid: 'job-1',
          controller: true,
        },
      ],
    },
    spec: {
      serviceAccountName: 'observer',
      automountServiceAccountToken: false,
    },
    status: { phase: 'Running' },
  };
  const deployment = {
    metadata: metadata('site-maintenance', 'maintenance'),
    spec: { replicas: 1, template: { spec } },
  };
  const replicaSet = {
    metadata: {
      ...metadata('maintenance-rs', 'rs-1'),
      ownerReferences: [
        {
          kind: 'Deployment',
          name: 'site-maintenance',
          uid: 'maintenance',
          controller: true,
        },
      ],
    },
    spec: { replicas: 1, template: { spec } },
  };
  const maintenance = {
    metadata: {
      ...metadata('maintenance-pod', 'maintenance-pod'),
      ownerReferences: [
        {
          kind: 'ReplicaSet',
          name: 'maintenance-rs',
          uid: 'rs-1',
          controller: true,
        },
      ],
    },
    spec,
    status: { phase: 'Running' },
  };
  const list = (kind: string, apiVersion: string, items: unknown[]) => ({
    kind: `${kind}List`,
    apiVersion,
    metadata: { resourceVersion: '1' },
    items,
  });
  return {
    policy: JSON.stringify({
      releaseName: 'site',
      image: spec.containers[0].image,
      configSha256: createHash('sha256').update(config).digest('hex'),
      serviceAccountName: 'default',
      migrationServiceAccountName: 'observer',
    }),
    payloads: new Map<string, object>([
      ['pods', list('Pod', 'v1', [pod, maintenance])],
      ['deployments', list('Deployment', 'apps/v1', [deployment])],
      ['replicasets', list('ReplicaSet', 'apps/v1', [replicaSet])],
      ['statefulsets', list('StatefulSet', 'apps/v1', [])],
      ['daemonsets', list('DaemonSet', 'apps/v1', [])],
      [
        'jobs',
        list('Job', 'batch/v1', [
          { metadata: metadata('site-migration-r1-1', 'job-1') },
        ]),
      ],
      ['cronjobs', list('CronJob', 'batch/v1', [])],
      [
        'horizontalpodautoscalers',
        list('HorizontalPodAutoscaler', 'autoscaling/v2', []),
      ],
      [
        'site-maintenance',
        {
          kind: 'ConfigMap',
          apiVersion: 'v1',
          metadata: metadata('site-maintenance', 'cm-1'),
          data: { 'default.conf': config },
        },
      ],
    ]),
  };
}

function withContinuous(inventory: ReturnType<typeof rawInventory>) {
  const labels = { 'app.kubernetes.io/instance': 'site', component: 'legal' };
  const data = { 'index.html': 'public legal page' };
  const policy: ContinuousStaticWorkload = {
    deploymentName: 'site-legal',
    selectorLabels: labels,
    podLabels: labels,
    serviceAccountName: 'static',
    image: `static@sha256:${'2'.repeat(64)}`,
    containerName: 'legal',
    command: ['static-server'],
    args: [],
    replicas: 1,
    runAsUser: 101,
    runAsGroup: 101,
    port: 8080,
    terminationGracePeriodSeconds: 30,
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '100m', memory: '64Mi' },
    },
    probes: { readinessProbe: null, livenessProbe: null, startupProbe: null },
    nodeSelector: {
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
    },
    readOnlyConfigMaps: [
      {
        volumeName: 'legal',
        configMapName: 'legal-v1',
        hash: createHash('sha256')
          .update(canonical({ data, binaryData: {} }))
          .digest('hex'),
        mountPath: '/public',
        items: [{ key: 'index.html', path: 'index.html' }],
      },
    ],
  };
  const metadata = (name: string, uid: string, extra = {}) => ({
    name,
    uid,
    namespace: 'test',
    generation: 1,
    labels,
    ...extra,
  });
  const owner = (kind: string, name: string, uid: string) => [
    { kind, name, uid, controller: true },
  ];
  const spec = expectedPodEnvelope(policy);
  const podLabels = { ...labels, 'pod-template-hash': 'hash1' };
  const add = (resource: string, item: unknown) => {
    const payload = inventory.payloads.get(resource) as { items: unknown[] };
    payload.items.push(item);
  };
  add('deployments', {
    metadata: metadata('site-legal', 'legal-dep'),
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
      },
      template: { metadata: { labels }, spec },
    },
    status: {
      observedGeneration: 1,
      replicas: 1,
      readyReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    },
  });
  add('replicasets', {
    metadata: metadata('legal-rs', 'legal-rs', {
      ownerReferences: owner('Deployment', 'site-legal', 'legal-dep'),
    }),
    spec: {
      replicas: 1,
      selector: { matchLabels: podLabels },
      template: { metadata: { labels: podLabels }, spec },
    },
    status: { observedGeneration: 1, replicas: 1, readyReplicas: 1 },
  });
  add('pods', {
    metadata: metadata('legal-pod', 'legal-pod', {
      labels: podLabels,
      ownerReferences: owner('ReplicaSet', 'legal-rs', 'legal-rs'),
    }),
    spec: { ...spec, nodeName: 'node-1' },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'legal',
          image: policy.image,
          imageID: `docker-pullable://${policy.image}`,
          ready: true,
          state: { running: {} },
        },
      ],
    },
  });
  inventory.payloads.set('legal-v1', {
    kind: 'ConfigMap',
    apiVersion: 'v1',
    metadata: metadata('legal-v1', 'legal-cm'),
    immutable: true,
    data,
  });
  inventory.payloads.set('networkpolicies', {
    kind: 'NetworkPolicyList',
    apiVersion: 'networking.k8s.io/v1',
    items: [
      {
        metadata: metadata('static-isolation', 'isolation'),
        spec: {
          podSelector: { matchLabels: labels },
          policyTypes: ['Egress'],
          egress: [],
        },
      },
    ],
  });
  inventory.policy = JSON.stringify({
    ...JSON.parse(inventory.policy),
    continuousStaticWorkloads: [policy],
  });
  return inventory;
}

function withWriterFence(inventory: ReturnType<typeof rawInventory>) {
  const hash = (v: unknown) =>
    createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const contract = { protected: 'platform-native-fence-contract' },
    programData = { 'keeper.mjs': 'approved' };
  const image = `keeper@sha256:${'1'.repeat(64)}`;
  const producerSpec = {
    serviceAccountName: 'keeper',
    containers: [
      {
        name: 'keeper',
        image,
        volumeMounts: [
          { name: 'program', mountPath: '/program', readOnly: true },
        ],
      },
    ],
    volumes: [{ name: 'program', configMap: { name: 'keeper-program' } }],
  };
  const controller = {
    kind: 'Job',
    apiVersion: 'batch/v1',
    metadata: {
      name: 'keeper-job',
      uid: 'keeper-job-1',
      namespace: 'platform',
    },
    spec: { template: { spec: producerSpec } },
  };
  const producerPod = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name: 'keeper-pod',
      uid: 'keeper-1',
      namespace: 'platform',
      ownerReferences: [
        {
          kind: 'Job',
          name: 'keeper-job',
          uid: 'keeper-job-1',
          controller: true,
        },
      ],
    },
    spec: { ...structuredClone(producerSpec), nodeName: 'node-1' },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'keeper',
          image,
          imageID: image,
          ready: true,
          state: { running: {} },
        },
      ],
    },
  };
  const program = {
    kind: 'ConfigMap',
    apiVersion: 'v1',
    metadata: {
      name: 'keeper-program',
      uid: 'program-1',
      namespace: 'platform',
    },
    immutable: true,
    data: programData,
  };
  const policy: WriterFenceLeasePolicy = {
    configMapName: 'writer-fence',
    configMapUid: 'fence-cm',
    namespaceUid: 'namespace-1',
    sourceRevision: 'a'.repeat(40),
    contractIdentity: hash(contract),
    databaseHost: 'postgres.platform.svc.cluster.local',
    maintenanceDatabase: 'postgres',
    targetDatabase: 'jobgeni_prod',
    adoptionId: 'adopt-1',
    epoch: 'epoch-1',
    phase: 'migrate',
    producer: {
      namespace: 'platform',
      serviceAccount: 'keeper',
      controller: {
        kind: 'Job',
        name: 'keeper-job',
        uid: 'keeper-job-1',
        specIdentity: hash(controller.spec),
      },
      program: {
        name: 'keeper-program',
        uid: 'program-1',
        sha256: hash(programData),
        image,
      },
    },
    pgVisibilityQualificationIdentity: 'b'.repeat(64),
    planIdentity: 'c'.repeat(64),
    fenceContractId: 'fence-v1',
    fenceContractIdentity: 'd'.repeat(64),
    namespacePolicyIdentity: 'e'.repeat(64),
    databasePolicyIdentity: 'f'.repeat(64),
  };
  const pods = (
    inventory.payloads.get('pods') as {
      items: { metadata: { name: string; uid: string }; spec: unknown }[];
    }
  ).items;
  const jobs = (
    inventory.payloads.get('jobs') as {
      items: { metadata: { name: string; uid: string }; spec?: unknown }[];
    }
  ).items;
  jobs[0].spec = {};
  const deployments = (
    inventory.payloads.get('deployments') as {
      items: { metadata: { name: string; uid: string }; spec: unknown }[];
    }
  ).items;
  const uids = {
    apiVersion: 'jobgeni.happyvertical.com/writer-fence-uids-v1',
    epoch: policy.epoch,
    namespaceUid: policy.namespaceUid,
    configMapUid: policy.configMapUid,
    migration: {
      jobName: jobs[0].metadata.name,
      jobUid: jobs[0].metadata.uid,
      jobSpecIdentity: hash(jobs[0].spec),
      podName: pods[0].metadata.name,
      podUid: pods[0].metadata.uid,
      podSpecIdentity: hash(pods[0].spec),
    },
    controllers: deployments.map((o) => ({
      kind: 'Deployment',
      name: o.metadata.name,
      uid: o.metadata.uid,
      specIdentity: hash(o.spec),
    })),
    readOnlyPods: pods.slice(1).map((o) => ({
      name: o.metadata.name,
      uid: o.metadata.uid,
      specIdentity: hash(o.spec),
    })),
    producer: { podName: 'keeper-pod', podUid: 'keeper-1' },
  };
  const observedAt = Date.now();
  const lease = {
    apiVersion: 'iolaus.happyvertical.com/writer-fence-lease-v1',
    source: 'smrt.happyvertical.com/writer-fence-v1',
    sourceRevision: policy.sourceRevision,
    contractIdentity: policy.contractIdentity,
    namespace: 'test',
    namespaceUid: policy.namespaceUid,
    databaseHost: policy.databaseHost,
    maintenanceDatabase: policy.maintenanceDatabase,
    targetDatabase: policy.targetDatabase,
    release: 'r1',
    attempt: 1,
    adoptionId: policy.adoptionId,
    epoch: policy.epoch,
    phase: policy.phase,
    migrationJobUid: 'job-1',
    migrationPodUid: 'pod-1',
    producer: {
      namespace: 'platform',
      serviceAccount: 'keeper',
      podUid: 'keeper-1',
    },
    uidMapIdentity: hash(uids),
    configMapUid: policy.configMapUid,
    pgVisibilityQualificationIdentity: policy.pgVisibilityQualificationIdentity,
    observedAt,
    expiresAt: observedAt + 20000,
    fence: {
      apiVersion: 'smrt.happyvertical.com/writer-fence-v1',
      contractId: policy.fenceContractId,
      contractIdentity: policy.fenceContractIdentity,
      adoptionId: policy.adoptionId,
      planIdentity: policy.planIdentity,
      namespace: 'test',
      epoch: policy.epoch,
      observedAt,
      expiresAt: observedAt + 20000,
      namespacePolicyIdentity: policy.namespacePolicyIdentity,
      databasePolicyIdentity: policy.databasePolicyIdentity,
      observations: ['namespace', 'database'].map((scope) => ({
        scope,
        identity: hash(scope),
        observedAt,
        activeWriters: 0,
      })),
    },
  };
  const config = {
    kind: 'ConfigMap',
    apiVersion: 'v1',
    metadata: {
      name: policy.configMapName,
      uid: policy.configMapUid,
      namespace: 'test',
      resourceVersion: '1',
    },
    data: {
      'contract.json': JSON.stringify(contract),
      'uids.json': JSON.stringify(uids),
      'lease.json': JSON.stringify(lease),
    },
  };
  inventory.policy = JSON.stringify({
    ...JSON.parse(inventory.policy),
    writerFenceLease: policy,
  });
  for (const [key, value] of [
    ['writer-fence', config],
    ['keeper-pod', producerPod],
    ['keeper-job', controller],
    ['keeper-program', program],
  ] as const)
    inventory.payloads.set(key, value);
  return { policy, lease, config, uids, producerPod };
}

describe('native Kubernetes observer HTTP/parsing boundary', () => {
  let inventory: ReturnType<typeof rawInventory>;
  let token: string;
  let refusedResource: string | undefined;
  beforeEach(() => {
    inventory = rawInventory();
    refusedResource = undefined;
    token = 'projected-token-1';
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1');
    vi.stubEnv('KUBERNETES_SERVICE_PORT_HTTPS', '443');
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    native.readFile.mockReset().mockImplementation(async (path: string) => {
      const file = path.slice(projection.length + 1);
      const values: Record<string, string> = {
        token,
        'ca.crt': ca,
        namespace: 'test',
        'pod-name': 'migrator',
        'pod-uid': 'pod-1',
      };
      if (!(file in values)) throw new Error('Missing projection');
      return values[file];
    });
    native.request
      .mockReset()
      .mockImplementation(
        (options: { path: string }, callback: (response: unknown) => void) => {
          const req = Object.assign(new EventEmitter(), {
            end: () =>
              queueMicrotask(() => {
                const response = Object.assign(new EventEmitter(), {
                  statusCode:
                    options.path.split('/').at(-1) === refusedResource
                      ? 403
                      : 200,
                  setEncoding: vi.fn(),
                });
                callback(response);
                response.emit(
                  'data',
                  JSON.stringify(
                    inventory.payloads.get(
                      options.path.split('/').at(-1) ?? '',
                    ),
                  ),
                );
                response.emit('end');
              }),
            destroy: (error: Error) => req.emit('error', error),
          });
          return req;
        },
      );
  });
  afterEach(() => vi.unstubAllEnvs());
  it('accepts raw list items without TypeMeta and uses projected TLS credentials on every read', async () => {
    await observeWriterExclusion(identity);
    expect(native.request).toHaveBeenCalledTimes(9);
    for (const [options] of native.request.mock.calls)
      expect(options).toMatchObject({
        hostname: '10.0.0.1',
        port: '443',
        ca,
        rejectUnauthorized: true,
        headers: { authorization: 'Bearer projected-token-1' },
        timeout: 5000,
      });
    expect(
      native.readFile.mock.calls.filter(
        ([path]) => path === `${projection}/token`,
      ),
    ).toHaveLength(10);
    token = 'projected-token-2';
    await observeWriterExclusion(identity);
    expect(native.readFile).toHaveBeenCalledTimes(28);
    expect(native.request.mock.calls.at(-1)?.[0].headers.authorization).toBe(
      'Bearer projected-token-2',
    );
  });
  it('reads every exact immutable static config and the complete native NetworkPolicy list', async () => {
    inventory = withContinuous(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    await observeWriterExclusion(identity);
    expect(native.request).toHaveBeenCalledTimes(11);
    expect(
      native.request.mock.calls.map(([options]) => options.path),
    ).toContain('/apis/networking.k8s.io/v1/namespaces/test/networkpolicies');
    expect(
      native.request.mock.calls.map(([options]) => options.path),
    ).toContain('/api/v1/namespaces/test/configmaps/legal-v1');
  });
  it.each([
    'networkpolicies',
    'legal-v1',
  ])('denies a refused %s API read without reflecting response values', async (resource) => {
    inventory = withContinuous(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    refusedResource = resource;
    inventory.payloads.set(resource, { message: 'canary-secret-api-response' });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Kubernetes observer inventory read failed.',
    );
  });
  it('denies a paginated NetworkPolicy list and a mismatched static config type', async () => {
    inventory = withContinuous(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    inventory.payloads.set('networkpolicies', {
      ...inventory.payloads.get('networkpolicies'),
      metadata: { continue: 'next' },
    });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      /incomplete/,
    );
    inventory.payloads.set('networkpolicies', {
      ...inventory.payloads.get('networkpolicies'),
      metadata: {},
    });
    inventory.payloads.set('legal-v1', {
      ...inventory.payloads.get('legal-v1'),
      kind: 'Secret',
    });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(/inventory/);
  });
  it('redacts native request construction errors and projected credential read errors', async () => {
    native.request.mockImplementation(() => {
      throw new Error('canary-secret-token');
    });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Kubernetes observer inventory read failed.',
    );
    native.readFile.mockRejectedValue(new Error('canary-secret-token'));
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Migration observer projection is incomplete.',
    );
  });
  it('fetches the named precreated lease afresh at every mutation safety callback with rotating credentials', async () => {
    const f = withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    await observeWriterExclusion(identity);
    expect(native.request.mock.calls.map(([o]) => o.path)).toContain(
      '/api/v1/namespaces/test/configmaps/writer-fence',
    );
    expect(native.request).toHaveBeenCalledTimes(13);
    token = 'refreshed-phase-token';
    f.lease.expiresAt = 1;
    f.config.data['lease.json'] = JSON.stringify(f.lease);
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
    expect(native.request).toHaveBeenCalledTimes(26);
    expect(native.request.mock.calls.at(-1)?.[0]).toMatchObject({
      ca,
      rejectUnauthorized: true,
      timeout: 5000,
      headers: { authorization: 'Bearer refreshed-phase-token' },
    });
    expect(
      native.request.mock.calls.every(
        ([options]) => !options.method || options.method === 'GET',
      ),
    ).toBe(true);
  });
  it('denies fresh lease with the wrong approved native migration UID', async () => {
    const f = withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    f.lease.migrationPodUid = 'forged-pod';
    f.config.data['lease.json'] = JSON.stringify(f.lease);
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
  });
  it('fails closed on refused lease reads and never reflects producer response data', async () => {
    withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    refusedResource = 'writer-fence';
    inventory.payloads.set('writer-fence', {
      message: 'canary-sensitive-producer-state',
    });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Kubernetes observer inventory read failed.',
    );
  });
  it('accepts a fresh retry lease with independently terminal migration history in native lists', async () => {
    withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    const jobs = inventory.payloads.get('jobs') as {
        items: Record<string, unknown>[];
      },
      pods = inventory.payloads.get('pods') as {
        items: Record<string, unknown>[];
      };
    const labels = { 'app.kubernetes.io/instance': 'site' };
    jobs.items.push({
      metadata: {
        name: 'old-migration',
        uid: 'old-job',
        namespace: 'test',
        labels,
      },
      spec: {},
      status: { active: 0, conditions: [{ type: 'Failed', status: 'True' }] },
    });
    const previous = {
      metadata: {
        name: 'old-pod',
        uid: 'old-pod',
        namespace: 'test',
        labels,
        ownerReferences: [
          {
            kind: 'Job',
            name: 'old-migration',
            uid: 'old-job',
            controller: true,
          },
        ],
      },
      spec: {},
      status: { phase: 'Failed' },
    };
    pods.items.push(previous);
    await expect(observeWriterExclusion(identity)).resolves.toBeUndefined();
    previous.status.phase = 'Running';
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      /writer Pod/,
    );
  });
  it('waits for authenticated null enrollment before first DB factory and never retries issued expiry', async () => {
    const f = withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    f.config.data['lease.json'] = 'null';
    const factory = vi.fn();
    const startup = waitForWriterFenceEnrollment(identity).then(factory);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(factory).not.toHaveBeenCalled();
    f.config.data['lease.json'] = JSON.stringify(f.lease);
    await startup;
    expect(factory).toHaveBeenCalledOnce();
    expect(
      native.request.mock.calls.filter(([o]) =>
        o.path.endsWith('/writer-fence'),
      ).length,
    ).toBeGreaterThan(1);
    f.lease.expiresAt = 1;
    f.config.data['lease.json'] = JSON.stringify(f.lease);
    factory.mockClear();
    const calls = native.request.mock.calls.length;
    await expect(
      waitForWriterFenceEnrollment(identity).then(factory),
    ).rejects.toThrow('Fresh native writer-fence lease is unverified.');
    expect(factory).not.toHaveBeenCalled();
    expect(native.request.mock.calls.length - calls).toBe(13);
  });
  it('bounds authenticated pending enrollment to thirty seconds without opening a database', async () => {
    const f = withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    f.config.data['lease.json'] = 'null';
    let clock = 0;
    const time = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const original = native.request.getMockImplementation();
    if (!original) throw new Error('Missing request fixture');
    native.request.mockImplementation(
      (options: { path: string }, callback: (res: unknown) => void) =>
        original(options, (response: unknown) => {
          if (options.path.endsWith('/keeper-program')) clock = 30000;
          callback(response);
        }),
    );
    const factory = vi.fn();
    try {
      await expect(
        waitForWriterFenceEnrollment(identity).then(factory),
      ).rejects.toThrow('Writer-fence startup enrollment timed out.');
      expect(factory).not.toHaveBeenCalled();
    } finally {
      time.mockRestore();
    }
  });
  it('does not retry a foreign enrollment even when its lease is null', async () => {
    const f = withWriterFence(inventory);
    vi.stubEnv('IOLAUS_MAINTENANCE_OBSERVER_POLICY', inventory.policy);
    f.uids.migration.podUid = 'foreign';
    f.config.data['uids.json'] = JSON.stringify(f.uids);
    f.config.data['lease.json'] = 'null';
    await expect(waitForWriterFenceEnrollment(identity)).rejects.toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
    expect(native.request).toHaveBeenCalledTimes(13);
  });
  it('rereads a rotating projected token before each request in a single poll', async () => {
    let sequence = 0;
    const read = native.readFile.getMockImplementation();
    if (!read) throw new Error('Missing test projection mock.');
    native.readFile.mockImplementation(async (path: string) =>
      path === `${projection}/token` ? `rotated-${++sequence}` : read(path),
    );
    await observeWriterExclusion(identity);
    expect(
      native.request.mock.calls.map(
        ([options]) => options.headers.authorization,
      ),
    ).toEqual(
      Array.from({ length: 9 }, (_, index) => `Bearer rotated-${index + 2}`),
    );
  });
  it.each([
    { kind: 'JobList' },
    { apiVersion: 'apps/v1' },
    { items: [{ kind: 'Job' }] },
    { items: [{ apiVersion: 'apps/v1' }] },
    { kind: undefined },
    { apiVersion: undefined },
  ])('refuses conflicting or missing list/item type metadata %j', async (change) => {
    inventory.payloads.set('pods', {
      ...inventory.payloads.get('pods'),
      ...change,
    });
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      /inventory|type/,
    );
  });
  it('refuses missing projection before any API request and never uses an environment token', async () => {
    vi.stubEnv('KUBERNETES_TOKEN', 'untrusted-env-token');
    native.readFile.mockRejectedValue(new Error('Missing projection'));
    await expect(observeWriterExclusion(identity)).rejects.toThrow(
      'Migration observer projection is incomplete.',
    );
    expect(native.request).not.toHaveBeenCalled();
  });
});
