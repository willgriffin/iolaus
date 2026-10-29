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
  const uids = {
    migrationJobUid: 'job-1',
    migrationPodUid: 'pod-1',
    approvedEpoch: 'epoch-1',
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
      podUid: 'keeper-1',
    },
    uidMapIdentity: hash(uids),
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
    attempt: 'a1',
    migrationJobUid: 'job-1',
    migrationPodUid: 'pod-1',
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
        'uidMapIdentity',
        'configMapUid',
        'pgVisibilityQualificationIdentity',
      ].map((key) => [key, structuredClone((policy as unknown as Obj)[key])]),
    ),
    ...context,
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
  return { policy, context, fence, lease, configMap };
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
