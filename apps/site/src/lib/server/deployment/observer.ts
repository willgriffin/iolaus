import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import {
  type ContinuousStaticWorkload,
  continuousStaticUids,
  validateContinuousStaticPolicies,
} from './continuous-static.js';
import {
  validateWriterFenceLeasePolicy,
  verifyWriterFenceLease,
  WriterFenceEnrollmentPending,
  type WriterFenceLeasePolicy,
  writerFenceProducerPodName,
} from './writer-fence.js';

const projection = '/var/run/secrets/kubernetes.io/serviceaccount';
const labelPrefix = 'smrt.happyvertical.com/';

export interface ReleaseIdentity {
  application: string;
  environment: string;
  release: string;
  attempt: string;
}

export function releaseIdentity(env = process.env): ReleaseIdentity {
  const values = [
    'SMRT_APP_NAME',
    'SMRT_APP_ENVIRONMENT',
    'SMRT_RELEASE_ID',
    'SMRT_RELEASE_ATTEMPT',
  ].map((key) => {
    const value = env[key];
    if (!value || !/^[a-z0-9][a-z0-9.-]*$/.test(value))
      throw new Error(`Missing or invalid ${key}.`);
    return value;
  });
  return {
    application: values[0],
    environment: values[1],
    release: values[2],
    attempt: values[3],
  };
}

interface KubeObject {
  apiVersion?: string;
  kind: string;
  metadata: {
    name: string;
    uid: string;
    namespace: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    ownerReferences?: {
      kind: string;
      uid: string;
      name: string;
      controller?: boolean;
    }[];
  };
  spec?: {
    replicas?: number;
    suspend?: boolean;
    template?: { spec?: PodSpec };
    serviceAccountName?: string;
    automountServiceAccountToken?: boolean;
    containers?: ContainerSpec[];
    volumes?: { name: string; configMap?: { name: string } }[];
    initContainers?: unknown[];
    ephemeralContainers?: unknown[];
  };
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
  status?: {
    phase?: string;
    replicas?: number;
    active?: number;
    conditions?: { type: string; status: string }[];
    readyReplicas?: number;
  };
}

interface ContainerSpec {
  image: string;
  command?: string[];
  env?: unknown[];
  envFrom?: unknown[];
  volumeMounts?: { name: string; mountPath: string; readOnly?: boolean }[];
}
type PodSpec = NonNullable<KubeObject['spec']>;
export interface MaintenanceObserverPolicy {
  releaseName: string;
  image: string;
  configSha256: string;
  serviceAccountName: string;
  migrationServiceAccountName: string;
  continuousStaticWorkloads?: ContinuousStaticWorkload[];
  writerFenceLease?: WriterFenceLeasePolicy;
}
export function maintenanceObserverPolicy(
  raw = process.env.IOLAUS_MAINTENANCE_OBSERVER_POLICY,
): MaintenanceObserverPolicy {
  let value: MaintenanceObserverPolicy;
  try {
    value = JSON.parse(raw ?? '');
  } catch {
    throw new Error('Maintenance observer policy is missing or invalid.');
  }
  const keys = [
    'releaseName',
    'image',
    'configSha256',
    'serviceAccountName',
    'migrationServiceAccountName',
  ];
  if (
    !value ||
    Object.keys(value).some(
      (key) =>
        ![...keys, 'continuousStaticWorkloads', 'writerFenceLease'].includes(
          key,
        ),
    ) ||
    Object.keys(value).length < keys.length ||
    keys.some(
      (key) =>
        typeof value[key as keyof MaintenanceObserverPolicy] !== 'string',
    ) ||
    !/^[a-z0-9][a-z0-9.-]*$/.test(value.releaseName) ||
    !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value.image) ||
    !/^[a-f0-9]{64}$/.test(value.configSha256) ||
    ![value.serviceAccountName, value.migrationServiceAccountName].every(
      (name) => /^[a-z0-9][a-z0-9.-]*$/.test(name),
    )
  )
    throw new Error('Maintenance observer policy is missing or invalid.');
  if (value.continuousStaticWorkloads !== undefined) {
    try {
      validateContinuousStaticPolicies(value.continuousStaticWorkloads);
    } catch {
      throw new Error('Maintenance observer policy is missing or invalid.');
    }
  }
  if (value.writerFenceLease !== undefined) {
    try {
      validateWriterFenceLeasePolicy(value.writerFenceLease);
    } catch {
      throw new Error('Maintenance observer policy is missing or invalid.');
    }
  }
  return value;
}
function assertMaintenanceSpec(
  spec: PodSpec | undefined,
  policy: MaintenanceObserverPolicy,
): void {
  const container = spec?.containers?.[0];
  const volume = spec?.volumes?.[0];
  const mount = container?.volumeMounts?.[0];
  if (
    spec?.automountServiceAccountToken !== false ||
    (spec.serviceAccountName ?? 'default') !== policy.serviceAccountName ||
    spec.containers?.length !== 1 ||
    spec.initContainers?.length ||
    spec.ephemeralContainers?.length ||
    container?.image !== policy.image ||
    JSON.stringify(container.command) !==
      JSON.stringify(['nginx', '-g', 'daemon off;']) ||
    container.env?.length ||
    container.envFrom?.length ||
    spec.volumes?.length !== 1 ||
    volume?.name !== 'config' ||
    volume.configMap?.name !== `${policy.releaseName}-maintenance` ||
    Object.keys(volume).some((key) => !['name', 'configMap'].includes(key)) ||
    container.volumeMounts?.length !== 1 ||
    mount?.name !== 'config' ||
    mount.mountPath !== '/etc/nginx/conf.d' ||
    mount.readOnly !== true
  )
    throw new Error(
      'Maintenance workload differs from approved nonwriter identity.',
    );
}
function maintenanceUids(
  snapshot: ObserverSnapshot,
  identity: ReleaseIdentity,
  policy: MaintenanceObserverPolicy,
): Set<string> {
  const config = snapshot.maintenanceConfig;
  if (
    config?.kind !== 'ConfigMap' ||
    config.metadata.name !== `${policy.releaseName}-maintenance` ||
    config.metadata.namespace !== snapshot.namespace ||
    !config.metadata.uid ||
    config.metadata.deletionTimestamp ||
    (config.binaryData && Object.keys(config.binaryData).length) ||
    Object.keys(config.data ?? {}).length !== 1 ||
    typeof config.data?.['default.conf'] !== 'string' ||
    createHash('sha256').update(config.data['default.conf']).digest('hex') !==
      policy.configSha256
  )
    throw new Error('Maintenance ConfigMap identity/hash is unverified.');
  const deployment = snapshot.objects.find(
    (object) =>
      object.kind === 'Deployment' &&
      object.metadata.name === `${policy.releaseName}-maintenance`,
  );
  const objects = [config, deployment];
  if (!deployment) throw new Error('Maintenance Deployment is absent.');
  assertMaintenanceSpec(deployment.spec?.template?.spec, policy);
  const uids = new Set([deployment.metadata.uid]);
  for (const replicaSet of snapshot.objects.filter(
    (object) =>
      object.kind === 'ReplicaSet' &&
      object.metadata.ownerReferences?.some(
        (owner) =>
          owner.controller === true &&
          owner.kind === 'Deployment' &&
          owner.uid === deployment.metadata.uid,
      ),
  )) {
    if (replicaSet.spec?.replicas === 0 && !replicaSet.status?.replicas)
      continue;
    assertMaintenanceSpec(replicaSet.spec?.template?.spec, policy);
    uids.add(replicaSet.metadata.uid);
    objects.push(replicaSet);
    for (const pod of snapshot.objects.filter(
      (object) =>
        object.kind === 'Pod' &&
        object.metadata.ownerReferences?.some(
          (owner) =>
            owner.controller === true &&
            owner.kind === 'ReplicaSet' &&
            owner.uid === replicaSet.metadata.uid,
        ),
    )) {
      assertMaintenanceSpec(pod.spec, policy);
      uids.add(pod.metadata.uid);
      objects.push(pod);
    }
  }
  for (const object of objects) {
    const labels = object?.metadata.labels;
    if (
      !object ||
      object.metadata.deletionTimestamp ||
      labels?.['app.kubernetes.io/instance'] !== policy.releaseName ||
      labels?.['app.kubernetes.io/name'] !== identity.application ||
      labels?.[`${labelPrefix}environment`] !== identity.environment ||
      labels?.[`${labelPrefix}release`] !== identity.release ||
      labels?.[`${labelPrefix}phase`] !== 'migrate'
    )
      throw new Error('Maintenance release identity is stale or unverified.');
  }
  return uids;
}
export interface ObserverSnapshot {
  namespace: string;
  podName: string;
  podUid: string;
  objects: KubeObject[];
  maintenanceConfig?: KubeObject;
  continuousConfigMaps?: unknown[];
  networkPolicies?: unknown[];
}

/** Dedicated namespace: unknown controllers and terminating writers fail closed. */
export function assertWriterExclusion(
  snapshot: ObserverSnapshot,
  identity: ReleaseIdentity,
  policy?: MaintenanceObserverPolicy,
): void {
  const ownPod = snapshot.objects.find(
    (object) =>
      object.kind === 'Pod' && object.metadata.name === snapshot.podName,
  );
  const labels = ownPod?.metadata.labels;
  if (
    !ownPod ||
    ownPod.metadata.uid !== snapshot.podUid ||
    ownPod.metadata.namespace !== snapshot.namespace ||
    ownPod.metadata.deletionTimestamp ||
    ownPod.status?.phase !== 'Running' ||
    labels?.[`${labelPrefix}component`] !== 'migration' ||
    labels?.[`${labelPrefix}release`] !== identity.release ||
    labels?.[`${labelPrefix}attempt`] !== identity.attempt
  )
    throw new Error('Migration Pod identity is stale or unverified.');
  const instance = labels['app.kubernetes.io/instance'];
  const owner = ownPod.metadata.ownerReferences?.find(
    (reference) => reference.kind === 'Job' && reference.controller === true,
  );
  const ownJob = snapshot.objects.find(
    (object) =>
      object.kind === 'Job' &&
      object.metadata.uid === owner?.uid &&
      object.metadata.name === owner?.name,
  );
  if (
    !instance ||
    !ownJob ||
    ownJob.metadata.name !==
      `${instance}-migration-${identity.release}-${identity.attempt}` ||
    ownJob.metadata.labels?.['app.kubernetes.io/name'] !==
      identity.application ||
    ownJob.metadata.labels?.[`${labelPrefix}environment`] !==
      identity.environment ||
    ownJob.metadata.labels?.[`${labelPrefix}release`] !== identity.release ||
    ownJob.metadata.deletionTimestamp
  )
    throw new Error('Migration Job identity is stale or unverified.');
  if (
    policy &&
    (instance !== policy.releaseName ||
      ownPod.spec?.serviceAccountName !== policy.migrationServiceAccountName ||
      ownPod.spec.automountServiceAccountToken !== false)
  )
    throw new Error('Migration service account identity is unverified.');
  const nonwriters = policy
    ? maintenanceUids(snapshot, identity, policy)
    : new Set<string>();
  if (policy?.continuousStaticWorkloads)
    for (const uid of continuousStaticUids(
      snapshot,
      policy.continuousStaticWorkloads,
    ))
      nonwriters.add(uid);
  for (const object of snapshot.objects) {
    if (
      !object.metadata.uid ||
      object.metadata.namespace !== snapshot.namespace ||
      object.metadata.labels?.['app.kubernetes.io/instance'] !== instance
    )
      throw new Error('Unknown workload in migration namespace.');
    if (object.metadata.deletionTimestamp)
      throw new Error('Terminating workload prevents migration.');
    if (nonwriters.has(object.metadata.uid)) continue;
    if (object.kind === 'Pod') {
      if (object.metadata.uid === snapshot.podUid) continue;
      if (!['Succeeded', 'Failed'].includes(object.status?.phase ?? ''))
        throw new Error('Active or unknown writer Pod prevents migration.');
    } else if (object.kind === 'Job') {
      if (object.metadata.uid === ownJob.metadata.uid) continue;
      if (
        (object.status?.active ?? 0) !== 0 ||
        !object.status?.conditions?.some(
          (condition) =>
            ['Complete', 'Failed'].includes(condition.type) &&
            condition.status === 'True',
        )
      )
        throw new Error('Active or nonterminal writer Job prevents migration.');
    } else if (['Deployment', 'ReplicaSet'].includes(object.kind)) {
      if (
        object.spec?.replicas !== 0 ||
        (object.status?.replicas ?? 0) !== 0 ||
        (object.status?.readyReplicas ?? 0) !== 0
      )
        throw new Error('Writer controller is not drained.');
    } else if (object.kind === 'CronJob') {
      if (object.spec?.suspend !== true)
        throw new Error('Writer CronJob is not suspended.');
    } else throw new Error('Unsupported writer controller prevents migration.');
  }
}

interface NativeInventory {
  items?: KubeObject[];
  metadata?: { continue?: string };
  kind?: string;
  apiVersion?: string;
}
async function readNativeInventory({
  api,
  resource,
  namespace,
  host,
  port,
  ca,
  deadline,
}: {
  api: string;
  resource: string;
  namespace: string;
  host: string;
  port: string;
  ca: string;
  deadline?: number;
}): Promise<NativeInventory> {
  // A projected token may rotate during a bounded inventory poll.
  const requestToken = (
    await readFile(`${projection}/token`, 'utf8').catch(() => {
      throw new Error('Migration observer projection is incomplete.');
    })
  ).trim();
  if (!/^[a-zA-Z0-9._-]{1,65536}$/.test(requestToken))
    throw new Error('Migration observer projection is incomplete.');
  const remaining =
    deadline === undefined
      ? 5000
      : Math.min(5000, Math.ceil(deadline - performance.now()));
  if (remaining <= 0)
    throw new Error('Writer-fence startup enrollment timed out.');
  return await new Promise<NativeInventory>((resolve, reject) => {
    const req = request(
      {
        hostname: host,
        port,
        method: 'GET',
        path: `/${api}/namespaces/${encodeURIComponent(namespace)}/${resource}`,
        ca,
        rejectUnauthorized: true,
        headers: { authorization: `Bearer ${requestToken}` },
        timeout: 5000,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 4 * 1024 * 1024)
            req.destroy(
              new Error('Observer response exceeds bounded inventory.'),
            );
        });
        response.on('end', () => {
          clearTimeout(timer);
          if (response.statusCode !== 200)
            return reject(
              new Error('Kubernetes observer inventory read refused.'),
            );
          try {
            const parsed: unknown = JSON.parse(body);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              throw new Error('Invalid inventory');
            resolve(parsed as NativeInventory);
          } catch {
            reject(new Error('Kubernetes observer inventory is invalid.'));
          }
        });
        response.on('error', () =>
          reject(new Error('Kubernetes observer TLS/read failed.')),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error('Kubernetes observer read timed out.')),
    );
    req.on('error', () =>
      reject(new Error('Kubernetes observer TLS/read failed.')),
    );
    const timer = setTimeout(
      () => req.destroy(new Error('Observer request deadline exceeded.')),
      remaining,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => clearTimeout(timer));
    req.end();
  }).catch(() => {
    throw new Error('Kubernetes observer inventory read failed.');
  });
}

/** Fresh TLS-verified API reads; credentials are reread for native token rotation. */
async function observeWriterExclusionOnce(
  identity: ReleaseIdentity,
  allowPending = false,
  deadline?: number,
): Promise<void> {
  const policy = maintenanceObserverPolicy();
  const [token, ca, namespace, podName, podUid] = await Promise.all(
    ['token', 'ca.crt', 'namespace', 'pod-name', 'pod-uid'].map(async (file) =>
      (
        await readFile(`${projection}/${file}`, 'utf8').catch(() => {
          throw new Error('Migration observer projection is incomplete.');
        })
      ).trim(),
    ),
  );
  if (
    !token ||
    !ca.includes('BEGIN CERTIFICATE') ||
    ![namespace, podName, podUid].every((value) =>
      /^[a-zA-Z0-9.-]+$/.test(value),
    )
  )
    throw new Error('Migration observer projection is incomplete.');
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || '443';
  if (!host || !/^\d+$/.test(port))
    throw new Error('Kubernetes service endpoint is unavailable.');
  const objects: KubeObject[] = [];
  let maintenanceConfig: KubeObject | undefined;
  const continuousConfigMaps: KubeObject[] = [];
  const networkPolicies: KubeObject[] = [];
  for (const [api, resource, kind, apiVersion] of [
    ['api/v1', 'pods', 'Pod', 'v1'],
    ['apis/apps/v1', 'deployments', 'Deployment', 'apps/v1'],
    ['apis/apps/v1', 'replicasets', 'ReplicaSet', 'apps/v1'],
    ['apis/apps/v1', 'statefulsets', 'StatefulSet', 'apps/v1'],
    ['apis/apps/v1', 'daemonsets', 'DaemonSet', 'apps/v1'],
    ['apis/batch/v1', 'jobs', 'Job', 'batch/v1'],
    ['apis/batch/v1', 'cronjobs', 'CronJob', 'batch/v1'],
    [
      'apis/autoscaling/v2',
      'horizontalpodautoscalers',
      'HorizontalPodAutoscaler',
      'autoscaling/v2',
    ],
    [
      'api/v1',
      `configmaps/${policy.releaseName}-maintenance`,
      'ConfigMap',
      'v1',
    ],
    ...(policy.continuousStaticWorkloads
      ? [
          [
            'apis/networking.k8s.io/v1',
            'networkpolicies',
            'NetworkPolicy',
            'networking.k8s.io/v1',
          ],
          ...[
            ...new Set(
              policy.continuousStaticWorkloads.flatMap((workload) =>
                workload.readOnlyConfigMaps.map(
                  (config) => config.configMapName,
                ),
              ),
            ),
          ].map((name) => ['api/v1', `configmaps/${name}`, 'ConfigMap', 'v1']),
        ]
      : []),
  ]) {
    const result = await readNativeInventory({
      api,
      resource,
      namespace,
      host,
      port,
      ca,
      deadline,
    });
    if (resource.startsWith('configmaps/')) {
      if (result.kind !== kind || result.apiVersion !== apiVersion)
        throw new Error('Maintenance ConfigMap inventory is invalid.');
      if (resource === `configmaps/${policy.releaseName}-maintenance`)
        maintenanceConfig = result as KubeObject;
      else continuousConfigMaps.push(result as KubeObject);
      continue;
    }
    if (
      result.kind !== `${kind}List` ||
      result.apiVersion !== apiVersion ||
      !Array.isArray(result.items) ||
      result.metadata?.continue
    )
      throw new Error(
        'Kubernetes observer inventory is incomplete or has conflicting type metadata.',
      );
    // Native list items omit TypeMeta; bind it to the trusted resource request.
    // Explicit conflicting item metadata is never overwritten or accepted.
    for (const item of result.items) {
      if (
        !item ||
        typeof item !== 'object' ||
        (item.kind !== undefined && item.kind !== kind) ||
        (item.apiVersion !== undefined && item.apiVersion !== apiVersion)
      )
        throw new Error(
          'Kubernetes observer item type conflicts with requested inventory.',
        );
      if (kind === 'NetworkPolicy')
        networkPolicies.push({ ...item, kind, apiVersion });
      else objects.push({ ...item, kind, apiVersion });
    }
  }
  assertWriterExclusion(
    {
      namespace,
      podName,
      podUid,
      objects,
      maintenanceConfig,
      continuousConfigMaps,
      networkPolicies,
    },
    identity,
    policy,
  );
  if (policy.writerFenceLease) {
    const migrationPod = objects.find(
      (object) =>
        object.kind === 'Pod' &&
        object.metadata.name === podName &&
        object.metadata.uid === podUid,
    );
    const job = migrationPod?.metadata.ownerReferences?.find(
      (owner) => owner.kind === 'Job' && owner.controller === true,
    );
    if (!job) throw new Error('Fresh native writer-fence lease is unverified.');
    // Separate GET after workload proof: never reuse a lease from an earlier phase.
    const lease = await readNativeInventory({
      api: 'api/v1',
      resource: `configmaps/${policy.writerFenceLease.configMapName}`,
      namespace,
      host,
      port,
      ca,
      deadline,
    });
    const p = policy.writerFenceLease;
    const producerPodName = writerFenceProducerPodName(lease, p, namespace);
    const get = (api: string, resource: string) =>
      readNativeInventory({
        api,
        resource,
        namespace: p.producer.namespace,
        host,
        port,
        ca,
        deadline,
      });
    const producerPod = await get('api/v1', `pods/${producerPodName}`);
    const controller = await get(
      p.producer.controller.kind === 'Job' ? 'apis/batch/v1' : 'apis/apps/v1',
      `${p.producer.controller.kind === 'Job' ? 'jobs' : 'deployments'}/${p.producer.controller.name}`,
    );
    const program = await get(
      'api/v1',
      `configmaps/${p.producer.program.name}`,
    );
    const producerObjects: unknown[] = [producerPod, controller, program];
    if (p.producer.controller.kind === 'Deployment') {
      const refs = (producerPod as KubeObject).metadata?.ownerReferences;
      const rs = refs?.find(
        (r) => r.kind === 'ReplicaSet' && r.controller === true,
      );
      if (!rs || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(rs.name))
        throw new Error('Fresh native writer-fence lease is unverified.');
      producerObjects.push(await get('apis/apps/v1', `replicasets/${rs.name}`));
    }
    verifyWriterFenceLease(
      lease,
      p,
      {
        namespace,
        release: identity.release,
        attempt: identity.attempt,
        migrationJobUid: job.uid,
        migrationPodUid: podUid,
        objects,
        producerObjects,
      },
      Date.now(),
      allowPending,
    );
  }
}

/** Mutation callbacks never retry an expired, changed or missing lease. */
export async function observeWriterExclusion(
  identity: ReleaseIdentity,
): Promise<void> {
  await observeWriterExclusionOnce(identity);
}
/** Run before database modules/factories: only authenticated null enrollment is retried. */
export async function waitForWriterFenceEnrollment(
  identity: ReleaseIdentity,
): Promise<void> {
  if (!maintenanceObserverPolicy().writerFenceLease) return;
  const deadline = performance.now() + 30_000;
  for (;;) {
    try {
      await observeWriterExclusionOnce(identity, true, deadline);
      return;
    } catch (error) {
      if (!(error instanceof WriterFenceEnrollmentPending)) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error('Writer-fence startup enrollment timed out.');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, remaining)),
      );
    }
  }
}
