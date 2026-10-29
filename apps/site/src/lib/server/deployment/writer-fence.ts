import { createHash } from 'node:crypto';

/** Independently admitted pins from the protected migration policy, never the lease. */
export interface WriterFenceLeasePolicy {
  configMapName: string;
  configMapUid: string;
  namespaceUid: string;
  sourceRevision: string;
  contractIdentity: string;
  databaseHost: string;
  maintenanceDatabase: 'postgres';
  targetDatabase: 'jobgeni_prod';
  adoptionId: string;
  epoch: string;
  phase: 'migrate';
  producer: { namespace: string; serviceAccount: string; podUid: string };
  uidMapIdentity: string;
  pgVisibilityQualificationIdentity: string;
  planIdentity: string;
  fenceContractId: string;
  fenceContractIdentity: string;
  namespacePolicyIdentity: string;
  databasePolicyIdentity: string;
}
export interface WriterFenceContext {
  namespace: string;
  release: string;
  attempt: string;
  migrationJobUid: string;
  migrationPodUid: string;
}
export interface WriterFence {
  apiVersion: 'smrt.happyvertical.com/writer-fence-v1';
  contractId: string;
  contractIdentity: string;
  adoptionId: string;
  planIdentity: string;
  namespace: string;
  epoch: string;
  observedAt: number;
  expiresAt: number;
  namespacePolicyIdentity: string;
  databasePolicyIdentity: string;
  observations: {
    scope: 'namespace' | 'database';
    identity: string;
    observedAt: number;
    activeWriters: 0;
  }[];
}
type Fields = Record<string, unknown>;
const apiVersion = 'smrt.happyvertical.com/writer-fence-v1';
const leaseVersion = 'iolaus.happyvertical.com/writer-fence-lease-v1';
const lifetime = 30_000;
const policyKeys = [
  'configMapName',
  'configMapUid',
  'namespaceUid',
  'sourceRevision',
  'contractIdentity',
  'databaseHost',
  'maintenanceDatabase',
  'targetDatabase',
  'adoptionId',
  'epoch',
  'phase',
  'producer',
  'uidMapIdentity',
  'pgVisibilityQualificationIdentity',
  'planIdentity',
  'fenceContractId',
  'fenceContractIdentity',
  'namespacePolicyIdentity',
  'databasePolicyIdentity',
];
const hashKeys = [
  'contractIdentity',
  'uidMapIdentity',
  'pgVisibilityQualificationIdentity',
  'planIdentity',
  'fenceContractIdentity',
  'namespacePolicyIdentity',
  'databasePolicyIdentity',
];
const producerKeys = ['namespace', 'serviceAccount', 'podUid'];
function fail(): never {
  throw new Error('Fresh native writer-fence lease is unverified.');
}
function object(raw: unknown): Fields {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
  return raw as Fields;
}
function exact(raw: Fields, keys: string[]): void {
  if (
    Object.keys(raw).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    fail();
}
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/.test(value);
const name = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value);
const sha = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function json(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 256 * 1024) fail();
  try {
    return JSON.parse(value);
  } catch {
    fail();
  }
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function validateWriterFenceLeasePolicy(
  raw: unknown,
): asserts raw is WriterFenceLeasePolicy {
  const p = object(raw);
  exact(p, policyKeys);
  if (
    !policyKeys
      .filter((key) => key !== 'producer')
      .every((key) => text(p[key])) ||
    !hashKeys.every((key) => sha(p[key])) ||
    !name(p.configMapName) ||
    !/^[a-f0-9]{40}$/.test(String(p.sourceRevision)) ||
    typeof p.databaseHost !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(p.databaseHost) ||
    p.maintenanceDatabase !== 'postgres' ||
    p.targetDatabase !== 'jobgeni_prod' ||
    p.phase !== 'migrate'
  )
    fail();
  const producer = object(p.producer);
  exact(producer, producerKeys);
  if (
    !name(producer.namespace) ||
    !name(producer.serviceAccount) ||
    !text(producer.podUid)
  )
    fail();
}
function fresh(observedAt: unknown, expiresAt: unknown, now: number): void {
  if (
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    Number(observedAt) < now - lifetime ||
    Number(observedAt) > now ||
    Number(expiresAt) <= now ||
    Number(expiresAt) > now + lifetime ||
    Number(expiresAt) - Number(observedAt) > lifetime
  )
    fail();
}

/** Reports a held hard fence only. Never creates, renews, releases, or caches it. */
export function verifyWriterFenceLease(
  rawConfigMap: unknown,
  p: WriterFenceLeasePolicy,
  context: WriterFenceContext,
  now = Date.now(),
): WriterFence {
  validateWriterFenceLeasePolicy(p);
  if (
    !Number.isSafeInteger(now) ||
    now < lifetime ||
    !Object.values(context).every(text)
  )
    fail();
  const cm = object(rawConfigMap);
  const meta = object(cm.metadata);
  if (
    cm.apiVersion !== 'v1' ||
    cm.kind !== 'ConfigMap' ||
    meta.name !== p.configMapName ||
    meta.uid !== p.configMapUid ||
    meta.namespace !== context.namespace ||
    meta.deletionTimestamp != null ||
    !text(meta.resourceVersion) ||
    (cm.immutable !== undefined && cm.immutable !== false) ||
    (cm.binaryData !== undefined && Object.keys(object(cm.binaryData)).length)
  )
    fail();
  const data = object(cm.data);
  exact(data, ['contract.json', 'uids.json', 'lease.json']);
  const contract = object(json(data['contract.json']));
  const uids = object(json(data['uids.json']));
  if (hash(contract) !== p.contractIdentity || hash(uids) !== p.uidMapIdentity)
    fail();
  const lease = object(json(data['lease.json']));
  exact(lease, [
    'apiVersion',
    'source',
    'sourceRevision',
    'contractIdentity',
    'namespace',
    'namespaceUid',
    'databaseHost',
    'maintenanceDatabase',
    'targetDatabase',
    'release',
    'attempt',
    'adoptionId',
    'epoch',
    'phase',
    'migrationJobUid',
    'migrationPodUid',
    'producer',
    'uidMapIdentity',
    'configMapUid',
    'pgVisibilityQualificationIdentity',
    'observedAt',
    'expiresAt',
    'fence',
  ]);
  if (lease.apiVersion !== leaseVersion || lease.source !== apiVersion) fail();
  for (const key of [
    'sourceRevision',
    'contractIdentity',
    'namespaceUid',
    'databaseHost',
    'maintenanceDatabase',
    'targetDatabase',
    'adoptionId',
    'epoch',
    'phase',
    'uidMapIdentity',
    'configMapUid',
    'pgVisibilityQualificationIdentity',
  ] as const)
    if (lease[key] !== p[key]) fail();
  for (const key of [
    'namespace',
    'release',
    'attempt',
    'migrationJobUid',
    'migrationPodUid',
  ] as const)
    if (lease[key] !== context[key]) fail();
  const producer = object(lease.producer);
  exact(producer, producerKeys);
  for (const key of producerKeys)
    if (producer[key] !== p.producer[key as keyof typeof p.producer]) fail();
  fresh(lease.observedAt, lease.expiresAt, now);
  const fence = object(lease.fence);
  // Kept exactly aligned with SMRT scripts/deployment/adopt.mjs writer-fence-v1.
  exact(fence, [
    'apiVersion',
    'contractId',
    'contractIdentity',
    'adoptionId',
    'planIdentity',
    'namespace',
    'epoch',
    'observedAt',
    'expiresAt',
    'namespacePolicyIdentity',
    'databasePolicyIdentity',
    'observations',
  ]);
  if (
    fence.apiVersion !== apiVersion ||
    fence.contractId !== p.fenceContractId ||
    fence.contractIdentity !== p.fenceContractIdentity ||
    fence.adoptionId !== p.adoptionId ||
    fence.planIdentity !== p.planIdentity ||
    fence.namespace !== context.namespace ||
    fence.epoch !== p.epoch ||
    fence.namespacePolicyIdentity !== p.namespacePolicyIdentity ||
    fence.databasePolicyIdentity !== p.databasePolicyIdentity
  )
    fail();
  fresh(fence.observedAt, fence.expiresAt, now);
  if (
    !Array.isArray(fence.observations) ||
    fence.observations.length < 2 ||
    fence.observations.length > 64
  )
    fail();
  const scopes = new Set();
  for (const raw of fence.observations) {
    const observation = object(raw);
    exact(observation, ['scope', 'identity', 'observedAt', 'activeWriters']);
    if (
      !['namespace', 'database'].includes(String(observation.scope)) ||
      !sha(observation.identity) ||
      !Number.isSafeInteger(observation.observedAt) ||
      Number(observation.observedAt) < now - lifetime ||
      Number(observation.observedAt) > now ||
      observation.activeWriters !== 0
    )
      fail();
    scopes.add(observation.scope);
  }
  if (!['namespace', 'database'].every((scope) => scopes.has(scope))) fail();
  return structuredClone(fence) as unknown as WriterFence;
}
