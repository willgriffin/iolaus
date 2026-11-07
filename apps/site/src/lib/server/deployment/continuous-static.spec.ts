import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ContinuousStaticWorkload,
  canonical,
  continuousStaticUids,
  expectedPodEnvelope,
  validateContinuousStaticPolicies,
} from './continuous-static.js';
import {
  assertWriterExclusion,
  maintenanceObserverPolicy,
  type ObserverSnapshot,
} from './observer.js';

type Obj = Record<string, unknown>;
const digest = '1'.repeat(64);
function fixture() {
  const data = { 'index.html': '<h1>legal</h1>' };
  const selectorLabels = { appName: 'legal' };
  const labels = {
    ...selectorLabels,
    'app.kubernetes.io/instance': 'site',
    component: 'legal',
    'app.kubernetes.io/part-of': 'public',
  };
  const policy: ContinuousStaticWorkload = {
    deploymentName: 'site-legal',
    selectorLabels,
    podLabels: labels,
    serviceAccountName: 'static',
    image: `nginx@sha256:${digest}`,
    containerName: 'legal',
    command: ['nginx'],
    args: ['-g', 'daemon off;'],
    replicas: 1,
    runAsUser: 101,
    runAsGroup: 101,
    nodeSelector: {
      'kubernetes.io/os': 'linux',
      'kubernetes.io/arch': 'amd64',
    },
    port: 8080,
    resources: {
      requests: { cpu: '10m', memory: '16Mi' },
      limits: { cpu: '100m', memory: '64Mi' },
    },
    terminationGracePeriodSeconds: 30,
    probes: {
      readinessProbe: {
        httpGet: { path: '/healthz', port: 8080, scheme: 'HTTP' },
        initialDelaySeconds: 0,
        periodSeconds: 10,
        timeoutSeconds: 1,
        successThreshold: 1,
        failureThreshold: 3,
      },
      livenessProbe: null,
      startupProbe: null,
    },
    readOnlyConfigMaps: [
      {
        volumeName: 'public',
        configMapName: 'legal-v1',
        hash: createHash('sha256')
          .update(canonical({ data, binaryData: {} }))
          .digest('hex'),
        mountPath: '/public',
        items: [{ key: 'index.html', path: 'index.html' }],
      },
    ],
  };
  const meta = (name: string, uid: string, extra = {}) => ({
    name,
    uid,
    namespace: 'test',
    labels,
    generation: 1,
    ...extra,
  });
  const owner = (kind: string, name: string, uid: string) => [
    { kind, name, uid, controller: true },
  ];
  const hashLabels = { ...labels, 'pod-template-hash': 'hash1' };
  const spec = expectedPodEnvelope(policy);
  const deployment: Obj = {
    kind: 'Deployment',
    metadata: meta('site-legal', 'dep'),
    spec: {
      replicas: 1,
      selector: { matchLabels: selectorLabels },
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
      availableReplicas: 1,
      updatedReplicas: 1,
    },
  };
  const replicaSet: Obj = {
    kind: 'ReplicaSet',
    metadata: meta('legal-hash1', 'rs', {
      ownerReferences: owner('Deployment', 'site-legal', 'dep'),
    }),
    spec: {
      replicas: 1,
      selector: {
        matchLabels: { ...selectorLabels, 'pod-template-hash': 'hash1' },
      },
      template: {
        metadata: { labels: hashLabels },
        spec: structuredClone(spec),
      },
    },
    status: { observedGeneration: 1, replicas: 1, readyReplicas: 1 },
  };
  const pod: Obj = {
    kind: 'Pod',
    metadata: meta('legal-hash1-pod', 'pod', {
      labels: hashLabels,
      ownerReferences: owner('ReplicaSet', 'legal-hash1', 'rs'),
    }),
    spec: { ...structuredClone(spec), nodeName: 'node-1' },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'legal',
          ready: true,
          image: policy.image,
          imageID: `docker-pullable://${policy.image}`,
          state: { running: { startedAt: 'now' } },
        },
      ],
    },
  };
  const input = {
    namespace: 'test',
    objects: [deployment, replicaSet, pod],
    continuousConfigMaps: [
      {
        kind: 'ConfigMap',
        metadata: meta('legal-v1', 'cm'),
        immutable: true,
        data,
      } as Obj,
    ],
    networkPolicies: [
      {
        kind: 'NetworkPolicy',
        metadata: meta('deny-egress', 'np'),
        spec: {
          podSelector: { matchLabels: labels },
          policyTypes: ['Egress'],
          egress: [],
        },
      } as Obj,
    ],
  };
  return { input, policy, deployment, replicaSet, pod };
}
function set(object: Obj, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor: unknown = object;
  for (const part of parts.slice(0, -1)) cursor = (cursor as Obj)[part];
  (cursor as Obj)[parts[parts.length - 1]] = value;
}
function check(f = fixture()) {
  return continuousStaticUids(f.input, [f.policy]);
}

describe('strict continuous static graph', () => {
  it('verifies only current native graph UIDs and canonical immutable config', () => {
    expect([...check()]).toEqual(['dep', 'rs', 'pod']);
    expect(canonical({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
  });
  it('rejects otherwise valid static Pods with admission network annotations', () => {
    const f = fixture();
    set(f.pod, 'metadata.annotations', {
      'k8s.v1.cni.cncf.io/networks': 'writer-network',
    });
    expect(() => check(f)).toThrow(
      'Continuous static identity, envelope or isolation is unverified.',
    );
  });
  it('accepts empty static Pod annotations like the closed template envelope', () => {
    const f = fixture();
    set(f.pod, 'metadata.annotations', {});
    expect(() => check(f)).not.toThrow();
  });
  it('matches native selector cloning independently of full template and Pod labels', () => {
    const f = fixture();
    expect(f.policy.selectorLabels).toEqual({ appName: 'legal' });
    expect(f.policy.podLabels).toEqual({
      appName: 'legal',
      'app.kubernetes.io/instance': 'site',
      component: 'legal',
      'app.kubernetes.io/part-of': 'public',
    });
    expect(() => check(f)).not.toThrow();
  });
  it.each([
    {
      appName: 'legal',
      component: 'legal',
      'pod-template-hash': 'hash1',
    },
    { appName: 'foreign', 'pod-template-hash': 'hash1' },
    { appName: 'legal', 'pod-template-hash': 'wrong' },
    { appName: 'legal' },
  ])('rejects extra/wrong ReplicaSet selector or hash %j', (matchLabels) => {
    const f = fixture();
    set(f.replicaSet, 'spec.selector', { matchLabels });
    expect(() => check(f)).toThrow();
  });
  it('allows only documented API defaults, never arbitrary PodSpec fields', () => {
    const f = fixture();
    Object.assign(f.pod.spec as Obj, {
      restartPolicy: 'Always',
      dnsPolicy: 'ClusterFirst',
      schedulerName: 'default-scheduler',
      enableServiceLinks: true,
      priority: 0,
      preemptionPolicy: 'PreemptLowerPriority',
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      serviceAccount: 'static',
    });
    set(
      f.pod,
      'spec.tolerations',
      ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable'].map(
        (key) => ({
          key,
          operator: 'Exists',
          effect: 'NoExecute',
          tolerationSeconds: 300,
        }),
      ),
    );
    delete (((f.pod.spec as Obj).containers as Obj[])[0].readinessProbe as Obj)
      .initialDelaySeconds;
    set(f.pod, 'spec.containers.0.imagePullPolicy', 'IfNotPresent');
    set(f.pod, 'spec.volumes.0.configMap.defaultMode', 420);
    expect(() => check(f)).not.toThrow();
  });
  it.each([
    ['spec.tolerations', [{ operator: 'Exists' }]],
    ['spec.hostNetwork', true],
    ['spec.hostPID', true],
    ['spec.hostIPC', true],
    ['spec.unknownField', true],
    ['spec.automountServiceAccountToken', true],
    ['spec.serviceAccountName', 'writer'],
    ['spec.nodeSelector', {}],
    ['spec.imagePullSecrets', [{ name: 'secret' }]],
    ['spec.initContainers', [{ name: 'init' }]],
    ['spec.ephemeralContainers', [{ name: 'debug' }]],
    [
      'spec.containers.0.env',
      [{ name: 'TOKEN', value: 'canary-secret-value' }],
    ],
    ['spec.containers.0.envFrom', [{ secretRef: { name: 'secret' } }]],
    ['spec.containers.0.securityContext.privileged', true],
    ['spec.containers.0.securityContext.allowPrivilegeEscalation', true],
    ['spec.containers.0.securityContext.readOnlyRootFilesystem', false],
    ['spec.containers.0.securityContext.capabilities.add', ['NET_ADMIN']],
    ['spec.containers.0.command', ['sh']],
    ['spec.containers.0.volumeMounts.0.subPath', 'secret'],
    ['spec.containers.0.volumeMounts.0.readOnly', false],
    ['spec.containers.0.volumeMounts.0.mountPath', '/other'],
    ['spec.volumes.0.hostPath', { path: '/' }],
    ['spec.containers.0.readinessProbe.httpGet.host', 'metadata.internal'],
    ['spec.containers.0.readinessProbe.exec', { command: ['sh'] }],
    ['spec.containers.0.resources.limits.cpu', '1000m'],
    ['spec.securityContext.seccompProfile.type', 'Unconfined'],
    ['status.phase', 'Pending'],
    ['status.conditions', []],
    ['status.containerStatuses.0.ready', false],
    [
      'status.containerStatuses.0.imageID',
      `docker-pullable://nginx@sha256:${'2'.repeat(64)}`,
    ],
    ['status.containerStatuses.0.image', 'other'],
    ['metadata.ownerReferences.0.uid', 'foreign'],
    ['metadata.ownerReferences.0.name', 'foreign'],
    ['metadata.deletionTimestamp', 'now'],
    ['metadata.labels.component', 'writer'],
    ['metadata.uid', 'rs'],
  ])('rejects Pod drift at %s without reflecting values', (path, value) => {
    const f = fixture();
    set(f.pod, path, value);
    expect(() => check(f)).toThrow(
      'Continuous static identity, envelope or isolation is unverified.',
    );
    try {
      check(f);
    } catch (error) {
      expect(String(error)).not.toContain('canary-secret-value');
    }
  });
  it.each([
    ['spec.strategy', undefined],
    ['spec.strategy.rollingUpdate.maxUnavailable', 1],
    ['spec.replicas', 2],
    ['spec.selector.matchLabels.component', 'writer'],
    ['spec.template.spec.containers.0.command', ['sh']],
    ['status.observedGeneration', 0],
    ['status.readyReplicas', 0],
    ['status.updatedReplicas', 0],
    ['metadata.ownerReferences', [{ controller: true, uid: 'foreign' }]],
    ['metadata.deletionTimestamp', 'now'],
  ])('rejects Deployment drift at %s', (path, value) => {
    const f = fixture();
    set(f.deployment, path, value);
    expect(() => check(f)).toThrow();
  });
  it('rejects even terminal same-label Pods outside the approved owner graph', () => {
    const f = fixture();
    const stale = structuredClone(f.pod);
    set(stale, 'metadata.uid', 'old-pod');
    set(stale, 'metadata.ownerReferences.0.uid', 'old-rs');
    set(stale, 'status.phase', 'Succeeded');
    f.input.objects.push(stale);
    expect(() => check(f)).toThrow();
  });
  it('rejects extra old Pods, missing Pods, duplicate UID, and owner spoofing', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) =>
        f.input.objects.push(structuredClone(f.pod)),
      (f: ReturnType<typeof fixture>) => f.input.objects.pop(),
      (f: ReturnType<typeof fixture>) =>
        set(f.replicaSet, 'metadata.ownerReferences.0.uid', 'foreign'),
      (f: ReturnType<typeof fixture>) =>
        set(f.replicaSet, 'spec.template.spec.containers.0.env', [
          { name: 'DATABASE_URL', value: 'canary' },
        ]),
      (f: ReturnType<typeof fixture>) =>
        set(f.replicaSet, 'status.readyReplicas', 0),
    ]) {
      const f = fixture();
      change(f);
      expect(() => check(f)).toThrow();
    }
  });
  it.each([
    ['immutable', false],
    ['data', { 'index.html': 'drift' }],
    ['data', { unexpected: 'value' }],
    ['binaryData', { unexpected: 'c2VjcmV0' }],
    ['metadata.namespace', 'other'],
    ['metadata.deletionTimestamp', 'now'],
  ])('rejects mutable/mismatched public config %s', (path, value) => {
    const f = fixture();
    set(f.input.continuousConfigMaps[0], path, value);
    expect(() => check(f)).toThrow();
  });
});

describe('continuous static closed producer policy', () => {
  it.each([
    ['writer', false],
    ['role', 'service'],
    ['port', 0],
    ['runAsUser', 0],
    ['replicas', 4],
    ['image', 'nginx:latest'],
    ['nodeSelector', { 'kubernetes.io/os': 'linux' }],
    ['readOnlyConfigMaps.0.items.0.path', '../secret'],
    ['readOnlyConfigMaps.0.mountPath', '/public/../secret'],
    ['probes.readinessProbe.httpGet.host', 'host'],
    ['probes.readinessProbe.httpGet.port', 80],
    ['probes.readinessProbe.httpGet.scheme', 'HTTPS'],
    ['probes.readinessProbe.httpGet.path', '/?token=secret'],
    ['resources.limits.cpu', 'unbounded'],
  ])('rejects invalid or extra policy field %s', (path, value) => {
    const f = fixture();
    set(f.policy as unknown as Obj, path, value);
    expect(() => validateContinuousStaticPolicies([f.policy])).toThrow();
  });
  it('accepts root path and checks exact allowed HTTP probes', () => {
    const f = fixture();
    if (f.policy.probes.readinessProbe)
      f.policy.probes.readinessProbe.httpGet.path = '/';
    expect(() => validateContinuousStaticPolicies([f.policy])).not.toThrow();
  });
});

describe('NetworkPolicy egress union against actual Pod labels', () => {
  it.each([
    {
      matchExpressions: [
        { key: 'component', operator: 'In', values: ['legal'] },
      ],
    },
    {
      matchExpressions: [
        { key: 'component', operator: 'NotIn', values: ['writer'] },
      ],
    },
    {
      matchExpressions: [
        { key: 'missing', operator: 'NotIn', values: ['writer'] },
      ],
    },
    { matchExpressions: [{ key: 'component', operator: 'Exists' }] },
    { matchExpressions: [{ key: 'missing', operator: 'DoesNotExist' }] },
  ])('supports standard selector expressions %j', (selector) => {
    const f = fixture();
    set(f.input.networkPolicies[0], 'spec.podSelector', selector);
    expect(() => check(f)).not.toThrow();
  });
  it('allows nonmatching egress grants and matching ingress-only policy', () => {
    const f = fixture();
    f.input.networkPolicies.push(
      {
        kind: 'NetworkPolicy',
        metadata: { name: 'other', uid: 'other', namespace: 'test' },
        spec: {
          podSelector: { matchLabels: { component: 'writer' } },
          policyTypes: ['Egress'],
          egress: [{}],
        },
      },
      {
        kind: 'NetworkPolicy',
        metadata: { name: 'ingress', uid: 'ingress', namespace: 'test' },
        spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{}] },
      },
    );
    expect(() => check(f)).not.toThrow();
  });
  it.each([
    ['spec.egress', [{}]],
    ['spec.policyTypes', ['Ingress']],
    ['spec.podSelector.matchLabels', { component: 'writer' }],
    [
      'spec.podSelector.matchExpressions',
      [{ key: 'component', operator: 'Unknown' }],
    ],
    [
      'spec.podSelector.matchExpressions',
      [{ key: 'component', operator: 'Exists', values: ['unexpected'] }],
    ],
    ['metadata.deletionTimestamp', 'now'],
  ])('denies missing isolation or malformed selection %s', (path, value) => {
    const f = fixture();
    set(f.input.networkPolicies[0], path, value);
    expect(() => check(f)).toThrow();
  });
  it('denies any matching egress grant despite a deny policy, including defaulted policyTypes', () => {
    for (const types of [undefined, ['Egress']]) {
      const f = fixture();
      f.input.networkPolicies.push({
        kind: 'NetworkPolicy',
        metadata: { name: 'allow', uid: 'allow', namespace: 'test' },
        spec: {
          podSelector: {},
          egress: [{}],
          ...(types ? { policyTypes: types } : {}),
        },
      });
      expect(() => check(f)).toThrow();
    }
  });
  it('requires complete config and network inventories', () => {
    const f = fixture();
    f.input.networkPolicies = [];
    expect(() => check(f)).toThrow();
    f.input.continuousConfigMaps = [];
    expect(() => check(f)).toThrow();
  });
});

describe('integration with existing maintenance writer exclusion', () => {
  function integrated() {
    const f = fixture();
    const identity = {
      application: 'iolaus',
      environment: 'test',
      release: 'r1',
      attempt: 'a1',
    };
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
    const maintenanceSpec = {
      serviceAccountName: 'maintenance',
      automountServiceAccountToken: false,
      containers: [
        {
          image: `nginx@sha256:${digest}`,
          command: ['nginx', '-g', 'daemon off;'],
          volumeMounts: [
            { name: 'config', mountPath: '/etc/nginx/conf.d', readOnly: true },
          ],
        },
      ],
      volumes: [{ name: 'config', configMap: { name: 'site-maintenance' } }],
    };
    const policy = maintenanceObserverPolicy(
      JSON.stringify({
        releaseName: 'site',
        image: `nginx@sha256:${digest}`,
        configSha256: createHash('sha256').update('maintenance').digest('hex'),
        serviceAccountName: 'maintenance',
        migrationServiceAccountName: 'observer',
        continuousStaticWorkloads: [f.policy],
      }),
    );
    const snapshot = {
      ...f.input,
      podName: 'migration',
      podUid: 'migration',
      maintenanceConfig: {
        kind: 'ConfigMap',
        metadata: metadata('site-maintenance', 'mcm'),
        data: { 'default.conf': 'maintenance' },
      },
      objects: [
        ...f.input.objects,
        {
          kind: 'Pod',
          metadata: {
            ...metadata('migration', 'migration'),
            labels: {
              ...labels,
              'smrt.happyvertical.com/component': 'migration',
              'smrt.happyvertical.com/attempt': 'a1',
            },
            ownerReferences: [
              {
                kind: 'Job',
                name: 'site-migration-r1-a1',
                uid: 'job',
                controller: true,
              },
            ],
          },
          spec: {
            serviceAccountName: 'observer',
            automountServiceAccountToken: false,
          },
          status: { phase: 'Running' },
        },
        { kind: 'Job', metadata: metadata('site-migration-r1-a1', 'job') },
        {
          kind: 'Deployment',
          metadata: metadata('site-maintenance', 'maintenance'),
          spec: { template: { spec: maintenanceSpec }, replicas: 1 },
        },
      ],
    } as unknown as ObserverSnapshot;
    return { snapshot, policy, identity };
  }
  it('accepts maintenance plus the exact approved continuous graph', () => {
    const f = integrated();
    expect(() =>
      assertWriterExclusion(f.snapshot, f.identity, f.policy),
    ).not.toThrow();
  });
  it('keeps legacy policy parsing and excludes the static graph when the optional policy is absent', () => {
    const f = integrated();
    delete f.policy.continuousStaticWorkloads;
    expect(() =>
      maintenanceObserverPolicy(JSON.stringify(f.policy)),
    ).not.toThrow();
    expect(() =>
      assertWriterExclusion(f.snapshot, f.identity, f.policy),
    ).toThrow(/not drained/);
  });
  it.each([
    'Pod',
    'Job',
    'HorizontalPodAutoscaler',
    'StatefulSet',
  ])('does not grant arbitrary same-label %s a nonwriter exception', (kind) => {
    const f = integrated();
    f.snapshot.objects.push({
      kind,
      metadata: {
        name: 'spoof',
        uid: 'spoof',
        namespace: 'test',
        labels: {
          'app.kubernetes.io/instance': 'site',
          'smrt.happyvertical.com/writer': 'false',
        },
      },
      status: { phase: 'Running' },
    });
    expect(() =>
      assertWriterExclusion(f.snapshot, f.identity, f.policy),
    ).toThrow();
  });
});
