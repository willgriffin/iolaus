import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { maintenanceObserverPolicy } from './observer.js';
import {
  validateWriterFenceLeasePolicy,
  verifyWriterFenceLease,
  type WriterFenceLeasePolicy,
} from './writer-fence.js';

const now = 1_900_000_000_000;
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Obj = Record<string, unknown>;
function fixture() {
  const contract = {
    source: 'reviewed-platform-contract',
    maintenanceDatabase: 'postgres',
    targetDatabase: 'jobgeni_prod',
  };
  const policy: WriterFenceLeasePolicy = {
    configMapName: 'writer-fence',
    configMapUid: 'cm-1',
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
      serviceAccount: 'fence-keeper',
      controller: {
        kind: 'Job',
        name: 'keeper-job',
        uid: 'keeper-job-1',
        specIdentity: '0'.repeat(64),
      },
      program: {
        name: 'keeper-program',
        uid: 'program-1',
        sha256: hash({ 'keeper.mjs': 'approved' }),
        image: `keeper@sha256:${'1'.repeat(64)}`,
      },
    },
    pgVisibilityQualificationIdentity: 'b'.repeat(64),
    planIdentity: 'c'.repeat(64),
    fenceContractId: 'jobgeni-fence-v1',
    fenceContractIdentity: 'd'.repeat(64),
    namespacePolicyIdentity: 'e'.repeat(64),
    databasePolicyIdentity: 'f'.repeat(64),
  };
  const context = {
    namespace: 'test',
    release: 'r1',
    attempt: '1',
    migrationJobUid: 'job-1',
    migrationPodUid: 'pod-1',
  };
  const ownJob = {
    kind: 'Job',
    apiVersion: 'batch/v1',
    metadata: { name: 'migration', uid: 'job-1', namespace: 'test' },
    spec: { template: { spec: { serviceAccountName: 'observer' } } },
  };
  const ownPod = {
    kind: 'Pod',
    apiVersion: 'v1',
    metadata: {
      name: 'migrator',
      uid: 'pod-1',
      namespace: 'test',
      ownerReferences: [
        { kind: 'Job', name: 'migration', uid: 'job-1', controller: true },
      ],
    },
    spec: { serviceAccountName: 'observer' },
  };
  const producerSpec = {
    serviceAccountName: 'fence-keeper',
    containers: [
      {
        name: 'keeper',
        image: policy.producer.program.image,
        volumeMounts: [
          { name: 'program', mountPath: '/program', readOnly: true },
        ],
      },
    ],
    volumes: [{ name: 'program', configMap: { name: 'keeper-program' } }],
  };
  const producerController = {
    kind: 'Job',
    apiVersion: 'batch/v1',
    metadata: {
      name: 'keeper-job',
      uid: 'keeper-job-1',
      namespace: 'platform',
    },
    spec: { template: { spec: producerSpec } },
  };
  policy.producer.controller.specIdentity = hash(producerController.spec);
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
          image: policy.producer.program.image,
          imageID: policy.producer.program.image,
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
    data: { 'keeper.mjs': 'approved' },
  };
  const uids = {
    apiVersion: 'jobgeni.happyvertical.com/writer-fence-uids-v1',
    epoch: policy.epoch,
    namespaceUid: policy.namespaceUid,
    configMapUid: policy.configMapUid,
    migration: {
      jobName: 'migration',
      jobUid: 'job-1',
      jobSpecIdentity: hash(ownJob.spec),
      podName: 'migrator',
      podUid: 'pod-1',
      podSpecIdentity: hash(ownPod.spec),
    },
    controllers: [],
    readOnlyPods: [],
    producer: { podName: 'keeper-pod', podUid: 'keeper-1' },
  };
  const nativeContext = {
    ...context,
    objects: [ownJob, ownPod],
    producerObjects: [producerPod, producerController, program],
  };
  const fence: Obj = {
    apiVersion: 'smrt.happyvertical.com/writer-fence-v1',
    contractId: policy.fenceContractId,
    contractIdentity: policy.fenceContractIdentity,
    adoptionId: policy.adoptionId,
    planIdentity: policy.planIdentity,
    namespace: context.namespace,
    epoch: policy.epoch,
    observedAt: now - 1000,
    expiresAt: now + 19000,
    namespacePolicyIdentity: policy.namespacePolicyIdentity,
    databasePolicyIdentity: policy.databasePolicyIdentity,
    observations: ['namespace', 'database'].map((scope) => ({
      scope,
      identity: hash(scope),
      observedAt: now - 1000,
      activeWriters: 0,
    })),
  };
  const lease: Obj = {
    apiVersion: 'iolaus.happyvertical.com/writer-fence-lease-v1',
    source: 'smrt.happyvertical.com/writer-fence-v1',
    ...Object.fromEntries(
      [
        'sourceRevision',
        'contractIdentity',
        'namespaceUid',
        'databaseHost',
        'maintenanceDatabase',
        'targetDatabase',
        'adoptionId',
        'epoch',
        'phase',
        'producer',
        'configMapUid',
        'pgVisibilityQualificationIdentity',
      ].map((key) => [key, structuredClone((policy as unknown as Obj)[key])]),
    ),
    ...context,
    attempt: Number(context.attempt),
    producer: {
      namespace: policy.producer.namespace,
      serviceAccount: policy.producer.serviceAccount,
      podUid: 'keeper-1',
    },
    uidMapIdentity: hash(uids),
    observedAt: now - 1000,
    expiresAt: now + 19000,
    fence,
  };
  const configMap = {
    kind: 'ConfigMap',
    apiVersion: 'v1',
    metadata: {
      name: policy.configMapName,
      uid: policy.configMapUid,
      namespace: context.namespace,
      resourceVersion: '1',
    },
    data: {
      'contract.json': JSON.stringify(contract),
      'uids.json': JSON.stringify(uids),
      'lease.json': JSON.stringify(lease),
    },
  };
  return {
    policy,
    context: nativeContext,
    fence,
    lease,
    configMap,
    uids,
    producerPod,
    producerController,
    program,
    ownPod,
    ownJob,
  };
}
function set(raw: unknown, path: string, value: unknown) {
  const parts = path.split('.');
  let cursor = raw as Obj;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Obj;
  cursor[parts[parts.length - 1]] = value;
}
function check(f = fixture()) {
  f.configMap.data['lease.json'] = JSON.stringify(f.lease);
  return verifyWriterFenceLease(f.configMap, f.policy, f.context, now);
}

describe('native writer-fence lease policy', () => {
  it('is optional for the existing observer and admits only the exact protected shape', () => {
    const old = {
      releaseName: 'site',
      image: `nginx@sha256:${'1'.repeat(64)}`,
      configSha256: '2'.repeat(64),
      serviceAccountName: 'maintenance',
      migrationServiceAccountName: 'observer',
    };
    expect(maintenanceObserverPolicy(JSON.stringify(old))).toEqual(old);
    const policy = fixture().policy;
    expect(
      maintenanceObserverPolicy(
        JSON.stringify({ ...old, writerFenceLease: policy }),
      ).writerFenceLease,
    ).toEqual(policy);
    expect(() =>
      maintenanceObserverPolicy(
        JSON.stringify({ ...old, writerFenceLease: true }),
      ),
    ).toThrow(/policy/);
  });
  it.each([
    ['ready', true],
    ['phase', 'complete'],
    ['maintenanceDatabase', 'jobgeni_prod'],
    ['targetDatabase', 'postgres'],
    ['sourceRevision', 'main'],
    ['contractIdentity', 'operator-approved'],
    ['pgVisibilityQualificationIdentity', null],
    ['configMapName', '../secret'],
    ['producer.extra', true],
    ['producer.podUid', ''],
    ['producer.serviceAccount', '*'],
    ['databaseHost', 'postgres://secret@host'],
    ['epoch', null],
  ])('rejects invalid protected pin %s', (path, value) => {
    const f = fixture();
    set(f.policy, path, value);
    expect(() => validateWriterFenceLeasePolicy(f.policy)).toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
  });
});

describe('fresh exact app/platform lease and upstream inner fence', () => {
  it('returns an independently cloned inner observation without creating or releasing a fence', () => {
    const f = fixture();
    const result = check(f);
    expect(result).toEqual(f.fence);
    result.observations[0].identity = 'changed';
    expect(check(f).observations[0].identity).not.toBe('changed');
    expect(f.configMap.metadata.resourceVersion).toBe('1');
  });
  it.each([
    ['apiVersion', 'writer-fence-v2'],
    ['source', 'operator-flag'],
    ['sourceRevision', 'b'.repeat(40)],
    ['contractIdentity', '0'.repeat(64)],
    ['namespace', 'foreign'],
    ['namespaceUid', 'recreated-namespace'],
    ['databaseHost', 'other.platform'],
    ['maintenanceDatabase', 'jobgeni_prod'],
    ['targetDatabase', 'postgres'],
    ['release', 'r0'],
    ['attempt', 'old'],
    ['adoptionId', 'other'],
    ['epoch', 'old'],
    ['phase', 'complete'],
    ['migrationJobUid', 'foreign-job'],
    ['migrationPodUid', 'foreign-pod'],
    ['producer.podUid', 'restarted-keeper'],
    ['producer.serviceAccount', 'default'],
    ['producer.namespace', 'foreign'],
    ['producer.extra', true],
    ['uidMapIdentity', '0'.repeat(64)],
    ['configMapUid', 'recreated-cm'],
    ['pgVisibilityQualificationIdentity', '0'.repeat(64)],
    ['ready', true],
    ['fence', null],
    ['observedAt', now + 1],
    ['observedAt', now - 30001],
    ['observedAt', String(now)],
    ['expiresAt', now],
    ['expiresAt', now + 30001],
    ['expiresAt', now + 30000],
    ['fence.apiVersion', 'smrt.happyvertical.com/writer-fence-v2'],
    ['fence.contractId', 'other'],
    ['fence.contractIdentity', '0'.repeat(64)],
    ['fence.planIdentity', '0'.repeat(64)],
    ['fence.namespace', 'foreign'],
    ['fence.adoptionId', 'other'],
    ['fence.epoch', 'old'],
    ['fence.namespacePolicyIdentity', '0'.repeat(64)],
    ['fence.databasePolicyIdentity', '0'.repeat(64)],
    ['fence.extra', true],
    ['fence.observedAt', now + 1],
    ['fence.observedAt', now - 30001],
    ['fence.expiresAt', now],
    ['fence.expiresAt', now + 30001],
    ['fence.expiresAt', now + 30000],
    ['fence.observations', []],
    ['fence.observations.0.scope', 'cluster'],
    ['fence.observations.1.scope', 'namespace'],
    ['fence.observations.0.activeWriters', 1],
    ['fence.observations.0.activeWriters', false],
    ['fence.observations.0.observedAt', now + 1],
    ['fence.observations.0.observedAt', now - 30001],
    ['fence.observations.0.identity', 'approved'],
    ['fence.observations.0.extra', true],
  ])('fails closed on lease/fence drift at %s', (path, value) => {
    const f = fixture();
    set(f.lease, path, value);
    expect(() => check(f)).toThrow(
      'Fresh native writer-fence lease is unverified.',
    );
  });
  it('accepts the exact maximum lifetime and oldest observation boundary', () => {
    const f = fixture();
    f.lease.observedAt = now;
    f.lease.expiresAt = now + 30000;
    f.fence.observedAt = now;
    f.fence.expiresAt = now + 30000;
    set(f.fence, 'observations.0.observedAt', now - 30000);
    expect(() => check(f)).not.toThrow();
  });
  it.each([
    ['kind', 'Secret'],
    ['apiVersion', 'v2'],
    ['metadata.name', 'other'],
    ['metadata.uid', 'new-cm'],
    ['metadata.namespace', 'foreign'],
    ['metadata.resourceVersion', undefined],
    ['metadata.deletionTimestamp', 'now'],
    ['immutable', true],
    ['binaryData', { credential: 'c2VjcmV0' }],
    ['data', { 'lease.json': 'null' }],
  ])('rejects malformed/recreated native ConfigMap %s', (path, value) => {
    const f = fixture();
    set(f.configMap, path, value);
    expect(() =>
      verifyWriterFenceLease(f.configMap, f.policy, f.context, now),
    ).toThrow('Fresh native writer-fence lease is unverified.');
  });
  it('rejects changed contract/map bytes, held/null and malformed leases with fixed redacted errors', () => {
    for (const key of ['contract.json', 'uids.json', 'lease.json'] as const)
      for (const value of [
        'null',
        '{malformed canary-sensitive-value',
        JSON.stringify({ unexpected: 'canary-sensitive-value' }),
      ]) {
        const f = fixture();
        f.configMap.data[key] = value;
        expect(() =>
          verifyWriterFenceLease(f.configMap, f.policy, f.context, now),
        ).toThrow('Fresh native writer-fence lease is unverified.');
      }
  });
  it('does not reuse a previous successful phase observation after context/time changes', () => {
    const f = fixture();
    expect(() => check(f)).not.toThrow();
    expect(() =>
      verifyWriterFenceLease(f.configMap, f.policy, f.context, now + 30000),
    ).toThrow();
    expect(() =>
      verifyWriterFenceLease(
        f.configMap,
        f.policy,
        { ...f.context, attempt: 'a2' },
        now,
      ),
    ).toThrow();
  });
});

describe('constructible native enrollment and restart', () => {
  it('constructs policy before migrationPod birth and enrolls later without changing policy', () => {
    const f = fixture(),
      admitted = JSON.stringify(f.policy);
    f.configMap.data['lease.json'] = 'null';
    f.configMap.data['uids.json'] = JSON.stringify({
      ...f.uids,
      migration: null,
    });
    expect(() =>
      verifyWriterFenceLease(f.configMap, f.policy, f.context, now, true),
    ).toThrow('Native writer-fence enrollment is pending.');
    expect(() =>
      verifyWriterFenceLease(f.configMap, f.policy, f.context, now),
    ).toThrow('Fresh native writer-fence lease is unverified.');
    f.configMap.data['uids.json'] = JSON.stringify(f.uids);
    expect(() => check(f)).not.toThrow();
    expect(JSON.stringify(f.policy)).toBe(admitted);
  });
  it('admits a native keeper Pod restart under the same stable controller policy, rejecting old lease', () => {
    const f = fixture(),
      admitted = JSON.stringify(f.policy);
    f.producerPod.metadata.uid = 'keeper-2';
    expect(() => check(f)).toThrow();
    f.uids.producer.podUid = 'keeper-2';
    f.configMap.data['uids.json'] = JSON.stringify(f.uids);
    expect(() => check(f)).toThrow();
    set(f.lease, 'producer.podUid', 'keeper-2');
    f.lease.uidMapIdentity = hash(f.uids);
    expect(() => check(f)).not.toThrow();
    expect(JSON.stringify(f.policy)).toBe(admitted);
  });
  it.each([
    'metadata.ownerReferences.0.uid',
    'spec.serviceAccountName',
    'spec.containers.0.image',
    'status.containerStatuses.0.imageID',
  ])('rejects producer Pod drift %s', (path) => {
    const f = fixture();
    set(f.producerPod, path, 'foreign');
    expect(() => check(f)).toThrow();
  });
  it('rejects program or controller replacement and unknown workload map despite recomputed hash', () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.program.data['keeper.mjs'] = 'other';
      },
      (f: ReturnType<typeof fixture>) => {
        f.producerController.metadata.uid = 'replacement';
      },
      (f: ReturnType<typeof fixture>) => {
        set(f.uids, 'migration.podUid', 'foreign');
      },
      (f: ReturnType<typeof fixture>) => {
        set(f.uids, 'controllers', [
          {
            kind: 'Deployment',
            name: 'writer',
            uid: 'writer',
            specIdentity: 'a'.repeat(64),
          },
        ]);
      },
    ]) {
      const f = fixture();
      change(f);
      f.configMap.data['uids.json'] = JSON.stringify(f.uids);
      f.lease.uidMapIdentity = hash(f.uids);
      expect(() => check(f)).toThrow();
    }
  });
});

describe('producer enrollment graph completeness', () => {
  it('accepts exact Deployment->ReplicaSet->Pod ownership with the same pinned template', () => {
    const f = fixture();
    const deployment = {
      ...f.producerController,
      kind: 'Deployment',
      apiVersion: 'apps/v1',
    };
    f.policy.producer.controller.kind = 'Deployment';
    f.policy.producer.controller.specIdentity = hash(deployment.spec);
    const rs = {
      kind: 'ReplicaSet',
      apiVersion: 'apps/v1',
      metadata: {
        name: 'keeper-rs',
        uid: 'keeper-rs-1',
        namespace: 'platform',
        ownerReferences: [
          {
            kind: 'Deployment',
            name: 'keeper-job',
            uid: 'keeper-job-1',
            controller: true,
          },
        ],
      },
      spec: structuredClone(deployment.spec),
    };
    f.producerPod.metadata.ownerReferences = [
      {
        kind: 'ReplicaSet',
        name: 'keeper-rs',
        uid: 'keeper-rs-1',
        controller: true,
      },
    ];
    f.context.producerObjects = [
      f.producerPod,
      deployment,
      f.program,
      rs,
    ] as typeof f.context.producerObjects;
    expect(() => check(f)).not.toThrow();
    rs.metadata.ownerReferences[0].uid = 'foreign';
    expect(() => check(f)).toThrow();
  });
  it('hashes immutable program data in sorted key order rather than API map insertion order', () => {
    const f = fixture();
    const data = { z: 'last', a: 'first' };
    set(f.program, 'data', data);
    f.policy.producer.program.sha256 = hash({ a: 'first', z: 'last' });
    expect(() => check(f)).not.toThrow();
  });
  it('rejects unknown producer API type and extra Pod spec fields', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.producerPod.apiVersion = 'wrong';
      },
      (f: ReturnType<typeof fixture>) =>
        set(f.producerPod, 'spec.hostNetwork', true),
    ]) {
      const f = fixture();
      mutate(f);
      expect(() => check(f)).toThrow();
    }
  });
});

describe('active native attempt contract', () => {
  it.each([
    'a1',
    '01',
    '0',
    '-1',
    '9007199254740992',
  ])('rejects noncanonical or unsafe environment attempt %s', (attempt) => {
    const f = fixture();
    expect(() =>
      verifyWriterFenceLease(
        f.configMap,
        f.policy,
        { ...f.context, attempt },
        now,
        true,
      ),
    ).toThrow('Fresh native writer-fence lease is unverified.');
  });
});
