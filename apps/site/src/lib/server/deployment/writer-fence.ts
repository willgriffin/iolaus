import { createHash } from 'node:crypto';
import { canonical } from './continuous-static.js';

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
  producer: {
    namespace: string;
    serviceAccount: string;
    controller: {
      kind: 'Job' | 'Deployment';
      name: string;
      uid: string;
      specIdentity: string;
    };
    program: { name: string; uid: string; sha256: string; image: string };
  };
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
  objects: unknown[];
  producerObjects: unknown[];
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
  'pgVisibilityQualificationIdentity',
  'planIdentity',
  'fenceContractId',
  'fenceContractIdentity',
  'namespacePolicyIdentity',
  'databasePolicyIdentity',
];
const hashKeys = [
  'contractIdentity',
  'pgVisibilityQualificationIdentity',
  'planIdentity',
  'fenceContractIdentity',
  'namespacePolicyIdentity',
  'databasePolicyIdentity',
];
const producerKeys = ['namespace', 'serviceAccount', 'podUid'];
export class WriterFenceEnrollmentPending extends Error {
  constructor() {
    super('Native writer-fence enrollment is pending.');
  }
}
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
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') fail();
  return createHash('sha256').update(serialized).digest('hex');
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
  exact(producer, ['namespace', 'serviceAccount', 'controller', 'program']);
  const controller = object(producer.controller),
    program = object(producer.program);
  exact(controller, ['kind', 'name', 'uid', 'specIdentity']);
  exact(program, ['name', 'uid', 'sha256', 'image']);
  if (
    !name(producer.namespace) ||
    !name(producer.serviceAccount) ||
    !['Job', 'Deployment'].includes(String(controller.kind)) ||
    !name(controller.name) ||
    !text(controller.uid) ||
    !sha(controller.specIdentity) ||
    !name(program.name) ||
    !text(program.uid) ||
    !sha(program.sha256) ||
    typeof program.image !== 'string' ||
    !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(program.image)
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

function enrollment(
  rawConfigMap: unknown,
  p: WriterFenceLeasePolicy,
  context: Pick<WriterFenceContext, 'namespace'>,
) {
  validateWriterFenceLeasePolicy(p);
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
  if (hash(contract) !== p.contractIdentity) fail();
  exact(uids, [
    'apiVersion',
    'epoch',
    'namespaceUid',
    'configMapUid',
    'migration',
    'controllers',
    'readOnlyPods',
    'producer',
  ]);
  if (
    uids.apiVersion !== 'jobgeni.happyvertical.com/writer-fence-uids-v1' ||
    uids.epoch !== p.epoch ||
    uids.namespaceUid !== p.namespaceUid ||
    uids.configMapUid !== p.configMapUid
  )
    fail();
  const enrolledProducer = object(uids.producer);
  exact(enrolledProducer, ['podName', 'podUid']);
  if (!name(enrolledProducer.podName) || !text(enrolledProducer.podUid)) fail();
  return { uids, lease: json(data['lease.json']) };
}
export function writerFenceProducerPodName(
  raw: unknown,
  p: WriterFenceLeasePolicy,
  namespace: string,
): string {
  return String(
    object(enrollment(raw, p, { namespace }).uids.producer).podName,
  );
}
function alive(raw: unknown, namespace: string, kind?: string): Fields {
  const o = object(raw),
    m = object(o.metadata);
  if (
    (kind && o.kind !== kind) ||
    m.namespace !== namespace ||
    !name(m.name) ||
    !text(m.uid) ||
    m.deletionTimestamp != null
  )
    fail();
  return m;
}
function owner(o: Fields, kind: string, parent: Fields): void {
  const refs = object(o.metadata).ownerReferences;
  if (!Array.isArray(refs) || refs.length !== 1) fail();
  const ref = object(refs[0]);
  if (
    ref.controller !== true ||
    ref.kind !== kind ||
    ref.uid !== parent.uid ||
    ref.name !== parent.name
  )
    fail();
}
function producerProof(
  p: WriterFenceLeasePolicy,
  u: Fields,
  objects: unknown[],
): string {
  const native = objects.map(object),
    enrolled = object(u.producer);
  if (native.length !== (p.producer.controller.kind === 'Job' ? 3 : 4)) fail();
  const versions = new Map([
    ['Pod', 'v1'],
    ['ConfigMap', 'v1'],
    ['Job', 'batch/v1'],
    ['Deployment', 'apps/v1'],
    ['ReplicaSet', 'apps/v1'],
  ]);
  for (const o of native)
    if (
      !versions.has(String(o.kind)) ||
      o.apiVersion !== versions.get(String(o.kind))
    )
      fail();
  const find = (kind: string, id: string) => {
    const matches = native.filter(
      (o) => o.kind === kind && object(o.metadata).name === id,
    );
    if (matches.length !== 1) fail();
    return matches[0];
  };
  const c = find(p.producer.controller.kind, p.producer.controller.name),
    cm = alive(c, p.producer.namespace, p.producer.controller.kind);
  if (
    (cm.ownerReferences != null &&
      (!Array.isArray(cm.ownerReferences) || cm.ownerReferences.length > 0)) ||
    cm.uid !== p.producer.controller.uid ||
    hash(c.spec) !== p.producer.controller.specIdentity
  )
    fail();
  const pod = find('Pod', String(enrolled.podName)),
    pm = alive(pod, p.producer.namespace, 'Pod');
  if (pm.uid !== enrolled.podUid) fail();
  let template = object(object(c.spec).template);
  if (c.kind === 'Deployment') {
    const sets = native.filter((o) => o.kind === 'ReplicaSet');
    if (sets.length !== 1) fail();
    const rs = sets[0],
      rm = alive(rs, p.producer.namespace, 'ReplicaSet');
    owner(rs, 'Deployment', cm);
    owner(pod, 'ReplicaSet', rm);
    const rsSpec = object(object(object(rs.spec).template).spec);
    if (canonical(rsSpec) !== canonical(template.spec)) fail();
    template = object(object(rs.spec).template);
  } else owner(pod, 'Job', cm);
  const ps = structuredClone(object(pod.spec)),
    expected = structuredClone(object(template.spec));
  if (typeof ps.nodeName !== 'string' || !name(ps.nodeName)) fail();
  delete ps.nodeName;
  for (const x of [ps, expected]) {
    if (x.serviceAccount !== undefined) {
      if (x.serviceAccount !== x.serviceAccountName) fail();
      delete x.serviceAccount;
    }
    if (x.priority === 0) delete x.priority;
    if (x.preemptionPolicy === 'PreemptLowerPriority')
      delete x.preemptionPolicy;
  }
  if (ps.tolerations !== undefined && expected.tolerations === undefined) {
    const defaults = [
      'node.kubernetes.io/not-ready',
      'node.kubernetes.io/unreachable',
    ].map((key) => ({
      key,
      operator: 'Exists',
      effect: 'NoExecute',
      tolerationSeconds: 300,
    }));
    if (canonical(ps.tolerations) !== canonical(defaults)) fail();
    delete ps.tolerations;
  }
  if (
    canonical(ps) !== canonical(expected) ||
    ps.serviceAccountName !== p.producer.serviceAccount
  )
    fail();
  const containers = ps.containers;
  if (
    !Array.isArray(containers) ||
    containers.length !== 1 ||
    object(containers[0]).image !== p.producer.program.image
  )
    fail();
  const status = object(pod.status);
  if (
    status.phase !== 'Running' ||
    !Array.isArray(status.conditions) ||
    !status.conditions.some((raw) => {
      const c = object(raw);
      return c.type === 'Ready' && c.status === 'True';
    })
  )
    fail();
  const states = status.containerStatuses;
  if (!Array.isArray(states) || states.length !== 1) fail();
  const state = object(states[0]),
    digest = p.producer.program.image.split('@')[1];
  if (
    state.name !== object(containers[0]).name ||
    state.ready !== true ||
    state.image !== p.producer.program.image ||
    ![
      p.producer.program.image,
      `docker-pullable://${p.producer.program.image}`,
      digest,
      `containerd://${digest}`,
    ].includes(String(state.imageID)) ||
    !object(state.state).running
  )
    fail();
  object(object(state.state).running);
  const program = find('ConfigMap', p.producer.program.name),
    progMeta = alive(program, p.producer.namespace, 'ConfigMap');
  if (
    progMeta.uid !== p.producer.program.uid ||
    program.immutable !== true ||
    (program.binaryData !== undefined &&
      Object.keys(object(program.binaryData)).length) ||
    hash(
      Object.fromEntries(
        Object.entries(object(program.data)).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
    ) !== p.producer.program.sha256
  )
    fail();
  const volumes = ps.volumes,
    mounts = object(containers[0]).volumeMounts;
  if (!Array.isArray(volumes) || !Array.isArray(mounts)) fail();
  const refs = volumes
    .map(object)
    .filter(
      (v) =>
        v.configMap && object(v.configMap).name === p.producer.program.name,
    );
  if (
    refs.length !== 1 ||
    !mounts
      .map(object)
      .some(
        (m) =>
          m.name === refs[0].name &&
          m.mountPath === '/program' &&
          m.readOnly === true,
      )
  )
    fail();
  return String(pm.uid);
}
/** The same terminal conditions used by the independent namespace observer. */
function terminalHistory(
  o: Fields,
  context: WriterFenceContext,
  instance: string,
): boolean {
  const meta = object(o.metadata);
  if (
    meta.uid === context.migrationJobUid ||
    meta.uid === context.migrationPodUid
  )
    return false;
  if (o.kind !== 'Job' && o.kind !== 'Pod') return false;
  const status = object(o.status ?? {});
  const terminal =
    o.kind === 'Pod'
      ? status.phase === 'Succeeded' || status.phase === 'Failed'
      : (status.active ?? 0) === 0 &&
        Array.isArray(status.conditions) &&
        status.conditions.some((raw) => {
          const c = object(raw);
          return (
            (c.type === 'Complete' || c.type === 'Failed') &&
            c.status === 'True'
          );
        });
  if (!terminal) return false;
  alive(o, context.namespace, String(o.kind));
  if (object(meta.labels)['app.kubernetes.io/instance'] !== instance) fail();
  return true;
}
function bindMap(u: Fields, context: WriterFenceContext): boolean {
  const objects = context.objects.map(object);
  const own = objects.filter(
    (o) =>
      o.kind === 'Pod' && object(o.metadata).uid === context.migrationPodUid,
  );
  if (own.length !== 1) fail();
  const instance = object(object(own[0].metadata).labels)[
    'app.kubernetes.io/instance'
  ];
  if (!text(instance)) fail();
  const active = objects.filter((o) => !terminalHistory(o, context, instance));
  const match = (
    kind: string,
    name: unknown,
    uid: unknown,
    spec: unknown,
    candidates = objects,
  ) => {
    const found = candidates.filter(
      (o) =>
        o.kind === kind &&
        object(o.metadata).name === name &&
        object(o.metadata).uid === uid,
    );
    if (found.length !== 1) fail();
    alive(found[0], context.namespace, kind);
    if (hash(found[0].spec) !== spec) fail();
    return found[0];
  };
  if (
    !Array.isArray(u.controllers) ||
    u.controllers.length > 64 ||
    !Array.isArray(u.readOnlyPods) ||
    u.readOnlyPods.length > 64
  )
    fail();
  const controllers = objects.filter((o) =>
    ['Deployment', 'CronJob'].includes(String(o.kind)),
  );
  if (controllers.length !== u.controllers.length) fail();
  const seen = new Set();
  for (const raw of u.controllers) {
    const e = object(raw);
    exact(e, ['kind', 'name', 'uid', 'specIdentity']);
    if (
      !['Deployment', 'CronJob'].includes(String(e.kind)) ||
      !sha(e.specIdentity) ||
      seen.has(e.uid)
    )
      fail();
    seen.add(e.uid);
    match(String(e.kind), e.name, e.uid, e.specIdentity);
  }
  const others = objects.filter(
    (o) =>
      o.kind === 'Pod' &&
      object(o.metadata).uid !== context.migrationPodUid &&
      !terminalHistory(o, context, instance),
  );
  if (others.length !== u.readOnlyPods.length) fail();
  for (const raw of u.readOnlyPods) {
    const e = object(raw);
    exact(e, ['name', 'uid', 'specIdentity']);
    if (
      !sha(e.specIdentity) ||
      seen.has(e.uid) ||
      e.uid === context.migrationPodUid
    )
      fail();
    seen.add(e.uid);
    match('Pod', e.name, e.uid, e.specIdentity, others);
  }
  const activeJobs = active.filter((o) => o.kind === 'Job');
  if (
    activeJobs.length !== 1 ||
    object(activeJobs[0].metadata).uid !== context.migrationJobUid
  )
    fail();
  if (u.migration === null) return false;
  const migration = object(u.migration);
  exact(migration, [
    'jobName',
    'jobUid',
    'jobSpecIdentity',
    'podName',
    'podUid',
    'podSpecIdentity',
  ]);
  if (
    migration.jobUid !== context.migrationJobUid ||
    migration.podUid !== context.migrationPodUid ||
    !sha(migration.jobSpecIdentity) ||
    !sha(migration.podSpecIdentity)
  )
    fail();
  const job = match(
      'Job',
      migration.jobName,
      migration.jobUid,
      migration.jobSpecIdentity,
    ),
    pod = match(
      'Pod',
      migration.podName,
      migration.podUid,
      migration.podSpecIdentity,
    );
  owner(pod, 'Job', object(job.metadata));
  return true;
}
/** Reports a held hard fence only. Never creates, renews, releases, or caches it. */
export function verifyWriterFenceLease(
  rawConfigMap: unknown,
  p: WriterFenceLeasePolicy,
  context: WriterFenceContext,
  now = Date.now(),
  allowPending = false,
): WriterFence {
  if (!Number.isSafeInteger(now) || now < lifetime) fail();
  if (
    !/^[1-9][0-9]{0,15}$/.test(context.attempt) ||
    !Number.isSafeInteger(Number(context.attempt))
  )
    fail();
  const { uids, lease: rawLease } = enrollment(rawConfigMap, p, context);
  const producerUid = producerProof(p, uids, context.producerObjects);
  const enrolled = bindMap(uids, context);
  if (rawLease === null) {
    if (allowPending) throw new WriterFenceEnrollmentPending();
    fail();
  }
  if (!enrolled) fail();
  const lease = object(rawLease);

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
    'configMapUid',
    'pgVisibilityQualificationIdentity',
  ] as const)
    if (lease[key] !== p[key]) fail();
  for (const key of [
    'namespace',
    'release',
    'migrationJobUid',
    'migrationPodUid',
  ] as const)
    if (lease[key] !== context[key]) fail();
  if (lease.attempt !== Number(context.attempt)) fail();
  const producer = object(lease.producer);
  exact(producer, producerKeys);
  if (
    producer.namespace !== p.producer.namespace ||
    producer.serviceAccount !== p.producer.serviceAccount ||
    producer.podUid !== producerUid ||
    lease.uidMapIdentity !== hash(uids)
  )
    fail();
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
