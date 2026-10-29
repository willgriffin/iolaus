import { createHash } from 'node:crypto';

/** Protected producer input, never inferred from workload labels or writer flags. */
export interface ContinuousStaticWorkload {
  deploymentName: string;
  selectorLabels: Record<string, string>;
  podLabels: Record<string, string>;
  serviceAccountName: string;
  image: string;
  containerName: string;
  command: string[];
  args: string[];
  replicas: number;
  port: number;
  resources: {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  };
  terminationGracePeriodSeconds: number;
  probes: {
    readinessProbe: HttpProbe | null;
    livenessProbe: HttpProbe | null;
    startupProbe: HttpProbe | null;
  };
  runAsUser: number;
  runAsGroup: number;
  nodeSelector: { 'kubernetes.io/os': 'linux'; 'kubernetes.io/arch': string };
  readOnlyConfigMaps: {
    volumeName: string;
    configMapName: string;
    hash: string;
    mountPath: string;
    items: { key: string; path: string }[];
  }[];
}
interface HttpProbe {
  httpGet: { path: string; port: number; scheme: 'HTTP' };
  initialDelaySeconds: number;
  periodSeconds: number;
  timeoutSeconds: number;
  successThreshold: number;
  failureThreshold: number;
}
type Fields = Record<string, unknown>;
function fail(): never {
  throw new Error(
    'Continuous static identity, envelope or isolation is unverified.',
  );
}
function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Fields;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}
function keys(value: Fields, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
function exactKeys(value: Fields, expected: string[]): void {
  keys(value, expected);
  if (Object.keys(value).length !== expected.length) fail();
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical((value as Fields)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
function same(actual: unknown, expected: unknown): void {
  if (canonical(actual) !== canonical(expected)) fail();
}
const name = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 253 &&
  /^[a-z0-9][a-z0-9.-]*$/.test(value);
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 256 &&
  /^[a-zA-Z0-9_./-]+$/.test(value) &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');
const sha = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function labels(value: unknown): Record<string, string> {
  const result = fields(value);
  if (
    !Object.keys(result).length ||
    Object.keys(result).length > 16 ||
    Object.entries(result).some(
      ([key, entry]) =>
        !/^[a-zA-Z0-9_./-]{1,253}$/.test(key) ||
        typeof entry !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,63}$/.test(entry),
    )
  )
    fail();
  return result as Record<string, string>;
}
export function validateContinuousStaticPolicies(
  value: unknown,
): asserts value is ContinuousStaticWorkload[] {
  const policies = list(value);
  if (!policies.length || policies.length > 8) fail();
  const names = new Set<string>();
  for (const raw of policies) {
    const p = fields(raw);
    exactKeys(p, [
      'deploymentName',
      'selectorLabels',
      'podLabels',
      'serviceAccountName',
      'image',
      'containerName',
      'command',
      'args',
      'replicas',
      'runAsUser',
      'runAsGroup',
      'nodeSelector',
      'readOnlyConfigMaps',
      'port',
      'resources',
      'terminationGracePeriodSeconds',
      'probes',
    ]);
    if (
      ![p.deploymentName, p.serviceAccountName, p.containerName].every(name) ||
      names.has(String(p.deploymentName)) ||
      typeof p.image !== 'string' ||
      !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(p.image) ||
      p.image.length > 512 ||
      !Number.isInteger(p.replicas) ||
      Number(p.replicas) < 1 ||
      Number(p.replicas) > 3 ||
      ![p.runAsUser, p.runAsGroup].every(
        (id) =>
          Number.isSafeInteger(id) &&
          Number(id) > 0 &&
          Number(id) <= 2147483647,
      )
    )
      fail();
    if (
      !Number.isInteger(p.port) ||
      Number(p.port) < 1 ||
      Number(p.port) > 65535 ||
      !Number.isInteger(p.terminationGracePeriodSeconds) ||
      Number(p.terminationGracePeriodSeconds) < 1 ||
      Number(p.terminationGracePeriodSeconds) > 120
    )
      fail();
    const resources = fields(p.resources);
    exactKeys(resources, ['requests', 'limits']);
    for (const key of ['requests', 'limits']) {
      const amounts = fields(resources[key]);
      exactKeys(amounts, ['cpu', 'memory']);
      for (const [kind, quantity] of Object.entries(amounts))
        if (
          typeof quantity !== 'string' ||
          quantity.length > 16 ||
          !(kind === 'cpu' ? /^[0-9]+m?$/ : /^[0-9]+(?:Ki|Mi|Gi)?$/).test(
            quantity,
          ) ||
          Number.parseInt(quantity, 10) <= 0
        )
          fail();
    }
    const probes = fields(p.probes);
    exactKeys(probes, ['readinessProbe', 'livenessProbe', 'startupProbe']);
    for (const [kind, rawProbe] of Object.entries(probes)) {
      if (rawProbe === null) continue;
      const probe = fields(rawProbe);
      exactKeys(probe, [
        'httpGet',
        'initialDelaySeconds',
        'periodSeconds',
        'timeoutSeconds',
        'successThreshold',
        'failureThreshold',
      ]);
      const get = fields(probe.httpGet);
      exactKeys(get, ['path', 'port', 'scheme']);
      if (
        typeof get.path !== 'string' ||
        !get.path.startsWith('/') ||
        (get.path !== '/' && !safePath(get.path.slice(1))) ||
        get.port !== p.port ||
        get.scheme !== 'HTTP'
      )
        fail();
      for (const key of [
        'initialDelaySeconds',
        'periodSeconds',
        'timeoutSeconds',
        'successThreshold',
        'failureThreshold',
      ])
        if (
          !Number.isInteger(probe[key]) ||
          Number(probe[key]) < (key === 'initialDelaySeconds' ? 0 : 1) ||
          Number(probe[key]) > (key === 'initialDelaySeconds' ? 300 : 120)
        )
          fail();
      if (kind !== 'readinessProbe' && probe.successThreshold !== 1) fail();
    }
    names.add(String(p.deploymentName));
    const selectorLabels = labels(p.selectorLabels);
    const podLabels = labels(p.podLabels);
    if (
      Object.entries(selectorLabels).some(
        ([key, value]) => podLabels[key] !== value,
      ) ||
      Object.hasOwn(podLabels, 'pod-template-hash')
    )
      fail();
    for (const argv of [p.command, p.args]) {
      if (
        list(argv).length > 32 ||
        list(argv).some(
          (arg) =>
            typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'),
        )
      )
        fail();
    }
    if (!list(p.command).length) fail();
    const node = fields(p.nodeSelector);
    exactKeys(node, ['kubernetes.io/os', 'kubernetes.io/arch']);
    if (
      node['kubernetes.io/os'] !== 'linux' ||
      !['amd64', 'arm64'].includes(String(node['kubernetes.io/arch']))
    )
      fail();
    const configs = list(p.readOnlyConfigMaps);
    if (!configs.length || configs.length > 8) fail();
    const volumes = new Set();
    const mounts: string[] = [];
    for (const rawConfig of configs) {
      const config = fields(rawConfig);
      exactKeys(config, [
        'volumeName',
        'configMapName',
        'hash',
        'mountPath',
        'items',
      ]);
      if (
        !name(config.volumeName) ||
        !name(config.configMapName) ||
        !sha(config.hash) ||
        typeof config.mountPath !== 'string' ||
        !config.mountPath.startsWith('/') ||
        !safePath(config.mountPath.slice(1)) ||
        volumes.has(config.volumeName) ||
        mounts.some(
          (mount) =>
            mount === config.mountPath ||
            mount.startsWith(`${config.mountPath}/`) ||
            String(config.mountPath).startsWith(`${mount}/`),
        )
      )
        fail();
      volumes.add(config.volumeName);
      mounts.push(config.mountPath);
      const items = list(config.items);
      if (!items.length || items.length > 64) fail();
      const paths: string[] = [];
      const itemKeys = new Set();
      for (const rawItem of items) {
        const item = fields(rawItem);
        exactKeys(item, ['key', 'path']);
        if (
          typeof item.key !== 'string' ||
          !/^[a-zA-Z0-9_.-]{1,253}$/.test(item.key) ||
          !safePath(item.path) ||
          item.path.startsWith('/') ||
          itemKeys.has(item.key) ||
          paths.some(
            (path) =>
              path === item.path ||
              path.startsWith(`${item.path}/`) ||
              String(item.path).startsWith(`${path}/`),
          )
        )
          fail();
        itemKeys.add(item.key);
        paths.push(item.path);
      }
    }
  }
}

/** Only these API-server defaults are erased; unknown fields are denied. */
function normalizeSpec(raw: unknown, pod: boolean): Fields {
  const spec = structuredClone(fields(raw));
  const defaults: Fields = {
    restartPolicy: 'Always',
    dnsPolicy: 'ClusterFirst',
    schedulerName: 'default-scheduler',
    enableServiceLinks: true,
    preemptionPolicy: 'PreemptLowerPriority',
    priority: 0,
    hostNetwork: false,
    hostPID: false,
    hostIPC: false,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (spec[key] !== undefined) {
      same(spec[key], value);
      delete spec[key];
    }
  }
  if (spec.serviceAccount !== undefined) {
    same(spec.serviceAccount, spec.serviceAccountName);
    delete spec.serviceAccount;
  }
  if (pod && spec.tolerations !== undefined) {
    const tolerations = list(spec.tolerations);
    const expected = [
      'node.kubernetes.io/not-ready',
      'node.kubernetes.io/unreachable',
    ].map((key) => ({
      key,
      operator: 'Exists',
      effect: 'NoExecute',
      tolerationSeconds: 300,
    }));
    same(tolerations.map(canonical).sort(), expected.map(canonical).sort());
    delete spec.tolerations;
  }
  if (pod) {
    if (typeof spec.nodeName !== 'string' || !name(spec.nodeName)) fail();
    delete spec.nodeName;
  }
  if (spec.initContainers !== undefined) {
    same(spec.initContainers, []);
    delete spec.initContainers;
  }
  if (spec.ephemeralContainers !== undefined) {
    same(spec.ephemeralContainers, []);
    delete spec.ephemeralContainers;
  }
  for (const rawContainer of list(spec.containers)) {
    const container = fields(rawContainer);
    for (const [key, value] of Object.entries({
      imagePullPolicy: 'IfNotPresent',
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
    })) {
      if (container[key] !== undefined) {
        same(container[key], value);
        delete container[key];
      }
    }
    for (const key of ['readinessProbe', 'livenessProbe', 'startupProbe']) {
      if (container[key] === undefined) continue;
      const probe = fields(container[key]);
      for (const [field, value] of Object.entries({
        initialDelaySeconds: 0,
        periodSeconds: 10,
        timeoutSeconds: 1,
        successThreshold: 1,
        failureThreshold: 3,
      }))
        if (probe[field] === undefined) probe[field] = value;
      const get = fields(probe.httpGet);
      if (get.scheme === undefined) get.scheme = 'HTTP';
      if (get.path === undefined) get.path = '/';
    }
    if (container.envFrom !== undefined) {
      same(container.envFrom, []);
      delete container.envFrom;
    }
    if (container.env === undefined) container.env = [];
    if (container.args === undefined) container.args = [];
  }
  for (const rawVolume of list(spec.volumes)) {
    const config = fields(fields(rawVolume).configMap);
    if (config.defaultMode !== undefined) {
      same(config.defaultMode, 420);
      delete config.defaultMode;
    }
    if (config.optional !== undefined) {
      same(config.optional, false);
      delete config.optional;
    }
  }
  return spec;
}
export function expectedPodEnvelope(p: ContinuousStaticWorkload): Fields {
  return {
    automountServiceAccountToken: false,
    serviceAccountName: p.serviceAccountName,
    nodeSelector: p.nodeSelector,
    terminationGracePeriodSeconds: p.terminationGracePeriodSeconds,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: p.runAsUser,
      runAsGroup: p.runAsGroup,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [
      {
        name: p.containerName,
        image: p.image,
        command: p.command,
        args: p.args,
        env: [],
        ports: [{ name: 'http', containerPort: p.port, protocol: 'TCP' }],
        resources: p.resources,
        ...Object.fromEntries(
          Object.entries(p.probes).filter(([, probe]) => probe !== null),
        ),
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: p.readOnlyConfigMaps.map((c) => ({
          name: c.volumeName,
          mountPath: c.mountPath,
          readOnly: true,
        })),
      },
    ],
    volumes: p.readOnlyConfigMaps.map((c) => ({
      name: c.volumeName,
      configMap: { name: c.configMapName, items: c.items },
    })),
  };
}
function selectorMatches(raw: unknown, actual: Fields): boolean {
  const selector = fields(raw);
  keys(selector, ['matchLabels', 'matchExpressions']);
  let match = true;
  if (selector.matchLabels !== undefined)
    for (const [key, value] of Object.entries(fields(selector.matchLabels))) {
      if (typeof value !== 'string') fail();
      if (actual[key] !== value) match = false;
    }
  if (selector.matchExpressions !== undefined)
    for (const rawExpression of list(selector.matchExpressions)) {
      const expression = fields(rawExpression);
      keys(expression, ['key', 'operator', 'values']);
      if (typeof expression.key !== 'string' || !expression.key) fail();
      const present = Object.hasOwn(actual, expression.key);
      const values =
        expression.values === undefined ? [] : list(expression.values);
      if (values.some((value) => typeof value !== 'string')) fail();
      if (['In', 'NotIn'].includes(String(expression.operator))) {
        if (!values.length) fail();
        const included = values.includes(actual[expression.key]);
        if (
          expression.operator === 'In'
            ? !present || !included
            : present && included
        )
          match = false;
      } else if (
        ['Exists', 'DoesNotExist'].includes(String(expression.operator))
      ) {
        if (values.length) fail();
        if (expression.operator === 'Exists' ? !present : present)
          match = false;
      } else fail();
    }
  return match;
}
function assertIsolation(
  policies: unknown[],
  podLabels: Fields,
  namespace: string,
): void {
  let isolated = false;
  for (const raw of policies) {
    const policy = fields(raw);
    const meta = fields(policy.metadata);
    if (
      policy.kind !== 'NetworkPolicy' ||
      meta.namespace !== namespace ||
      !meta.uid ||
      meta.deletionTimestamp
    )
      fail();
    const spec = fields(policy.spec);
    keys(spec, ['podSelector', 'policyTypes', 'ingress', 'egress']);
    const matches = selectorMatches(spec.podSelector, podLabels);
    const types =
      spec.policyTypes === undefined
        ? ['Ingress', ...(spec.egress !== undefined ? ['Egress'] : [])]
        : list(spec.policyTypes);
    if (
      !types.length ||
      types.some((type) => !['Ingress', 'Egress'].includes(String(type)))
    )
      fail();
    if (matches && types.includes('Egress')) {
      if (spec.egress !== undefined && list(spec.egress).length) fail();
      // Isolation must be explicit, not inferred from a default or a truthy flag.
      if (
        Array.isArray(spec.policyTypes) &&
        spec.policyTypes.includes('Egress')
      )
        isolated = true;
    }
  }
  if (!isolated) fail();
}
function objectMetadata(object: Fields, namespace: string): Fields {
  const meta = fields(object.metadata);
  if (
    !name(meta.name) ||
    typeof meta.uid !== 'string' ||
    !meta.uid ||
    meta.namespace !== namespace ||
    meta.deletionTimestamp
  )
    fail();
  return meta;
}
function owned(object: Fields, parent: Fields, kind: string): boolean {
  const owners = fields(object.metadata).ownerReferences;
  if (!Array.isArray(owners)) return false;
  const controllers = owners
    .map(fields)
    .filter((owner) => owner.controller === true);
  return (
    controllers.length === 1 &&
    controllers[0].uid === parent.uid &&
    controllers[0].name === parent.name &&
    controllers[0].kind === kind
  );
}
function assertTemplate(
  object: Fields,
  p: ContinuousStaticWorkload,
  namespace: string,
): void {
  const template = fields(fields(object.spec).template);
  keys(template, ['metadata', 'spec']);
  const meta = fields(template.metadata);
  keys(meta, ['labels', 'annotations', 'creationTimestamp']);
  if (meta.annotations !== undefined) same(meta.annotations, {});
  if (meta.creationTimestamp !== undefined) same(meta.creationTimestamp, null);
  const templateLabels = fields(meta.labels);
  for (const [key, value] of Object.entries(p.podLabels))
    if (templateLabels[key] !== value) fail();
  // The controller's hash is the only unprotected template label.
  if (object.kind === 'ReplicaSet') {
    if (
      typeof templateLabels['pod-template-hash'] !== 'string' ||
      !/^[a-z0-9-]{1,63}$/.test(templateLabels['pod-template-hash'])
    )
      fail();
    keys(templateLabels, [...Object.keys(p.podLabels), 'pod-template-hash']);
  } else same(templateLabels, p.podLabels);
  same(normalizeSpec(template.spec, false), expectedPodEnvelope(p));
  objectMetadata(object, namespace);
}
/** Returns only UIDs proved by the current complete namespace inventory. */
export function continuousStaticUids(
  input: {
    namespace: string;
    objects: unknown[];
    continuousConfigMaps?: unknown[];
    networkPolicies?: unknown[];
  },
  policies: ContinuousStaticWorkload[],
): Set<string> {
  validateContinuousStaticPolicies(policies);
  if (
    !Array.isArray(input.continuousConfigMaps) ||
    !Array.isArray(input.networkPolicies)
  )
    fail();
  const objects = input.objects.map(fields);
  const seen = new Set();
  for (const object of objects) {
    const meta = fields(object.metadata);
    if (!meta.uid || seen.has(meta.uid)) fail();
    seen.add(meta.uid);
  }
  const verified = new Set<string>();
  for (const p of policies) {
    for (const c of p.readOnlyConfigMaps) {
      const matches = input.continuousConfigMaps
        .map(fields)
        .filter((cm) => fields(cm.metadata).name === c.configMapName);
      if (matches.length !== 1) fail();
      const cm = matches[0];
      objectMetadata(cm, input.namespace);
      if (cm.kind !== 'ConfigMap' || cm.immutable !== true) fail();
      const data = cm.data === undefined ? {} : fields(cm.data);
      const binaryData =
        cm.binaryData === undefined ? {} : fields(cm.binaryData);
      if (
        Object.values(data).some((value) => typeof value !== 'string') ||
        Object.values(binaryData).some((value) => typeof value !== 'string') ||
        Object.keys(data).some((key) => Object.hasOwn(binaryData, key))
      )
        fail();
      same(
        createHash('sha256')
          .update(canonical({ data, binaryData }))
          .digest('hex'),
        c.hash,
      );
      for (const item of c.items)
        if (
          !Object.hasOwn(data, item.key) &&
          !Object.hasOwn(binaryData, item.key)
        )
          fail();
      same(
        Object.keys({ ...data, ...binaryData }).sort(),
        c.items.map((item) => item.key).sort(),
      );
    }
    const deployments = objects.filter(
      (object) =>
        object.kind === 'Deployment' &&
        fields(object.metadata).name === p.deploymentName,
    );
    if (deployments.length !== 1) fail();
    const deployment = deployments[0];
    const dm = objectMetadata(deployment, input.namespace);
    if (dm.ownerReferences !== undefined && list(dm.ownerReferences).length)
      fail();
    const ds = fields(deployment.spec);
    keys(ds, [
      'replicas',
      'selector',
      'template',
      'strategy',
      'revisionHistoryLimit',
      'progressDeadlineSeconds',
      'paused',
      'minReadySeconds',
    ]);
    same(ds.replicas, p.replicas);
    same(ds.selector, { matchLabels: p.selectorLabels });
    same(ds.strategy, {
      type: 'RollingUpdate',
      rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
    });
    for (const [key, expected] of Object.entries({
      revisionHistoryLimit: 10,
      progressDeadlineSeconds: 600,
      paused: false,
      minReadySeconds: 0,
    }))
      if (ds[key] !== undefined) same(ds[key], expected);
    assertTemplate(deployment, p, input.namespace);
    const status = fields(deployment.status);
    if (
      status.observedGeneration !== dm.generation ||
      !Number.isSafeInteger(dm.generation)
    )
      fail();
    for (const key of [
      'replicas',
      'readyReplicas',
      'availableReplicas',
      'updatedReplicas',
    ])
      same(status[key], p.replicas);
    if (status.unavailableReplicas !== undefined)
      same(status.unavailableReplicas, 0);
    verified.add(String(dm.uid));
    const sets = objects.filter(
      (object) =>
        object.kind === 'ReplicaSet' && owned(object, dm, 'Deployment'),
    );
    const active = sets.filter(
      (object) =>
        fields(object.spec).replicas !== 0 ||
        Number(fields(object.status).replicas ?? 0) !== 0,
    );
    if (active.length !== 1) fail();
    const rs = active[0];
    const rm = objectMetadata(rs, input.namespace);
    const rss = fields(rs.spec);
    keys(rss, ['replicas', 'selector', 'template', 'minReadySeconds']);
    if (rss.minReadySeconds !== undefined) same(rss.minReadySeconds, 0);
    same(rss.replicas, p.replicas);
    assertTemplate(rs, p, input.namespace);
    const hash = fields(fields(rss.template).metadata).labels;
    const selector = fields(rss.selector);
    // Kubernetes clones the Deployment selector separately from full template labels.
    same(selector, {
      matchLabels: {
        ...p.selectorLabels,
        'pod-template-hash': fields(hash)['pod-template-hash'],
      },
    });
    const rsStatus = fields(rs.status);
    same(rsStatus.replicas, p.replicas);
    same(rsStatus.readyReplicas, p.replicas);
    if (
      rsStatus.observedGeneration !== rm.generation ||
      !Number.isSafeInteger(rm.generation)
    )
      fail();
    verified.add(String(rm.uid));
    const pods = objects.filter(
      (object) => object.kind === 'Pod' && owned(object, rm, 'ReplicaSet'),
    );
    if (pods.length !== p.replicas) fail();
    for (const pod of pods) {
      const meta = objectMetadata(pod, input.namespace);
      same(meta.labels, hash);
      same(normalizeSpec(pod.spec, true), expectedPodEnvelope(p));
      const ps = fields(pod.status);
      if (
        ps.phase !== 'Running' ||
        !list(ps.conditions).some((raw) => {
          const condition = fields(raw);
          return condition.type === 'Ready' && condition.status === 'True';
        })
      )
        fail();
      const states = list(ps.containerStatuses);
      if (states.length !== 1) fail();
      const state = fields(states[0]);
      const runtimeState = fields(state.state);
      exactKeys(runtimeState, ['running']);
      fields(runtimeState.running);
      if (
        state.name !== p.containerName ||
        state.ready !== true ||
        state.image !== p.image ||
        typeof state.imageID !== 'string' ||
        ![
          p.image,
          `docker-pullable://${p.image}`,
          `containerd://${p.image.slice(p.image.indexOf('@') + 1)}`,
          p.image.slice(p.image.indexOf('@') + 1),
        ].includes(state.imageID) ||
        !fields(state.state).running
      )
        fail();
      assertIsolation(
        input.networkPolicies,
        fields(meta.labels),
        input.namespace,
      );
      verified.add(String(meta.uid));
    }
    // A retained terminal or stale same-label Pod is not a static proof either.
    for (const object of objects) {
      if (object.kind !== 'Pod') continue;
      const meta = fields(object.metadata);
      const actual = fields(meta.labels ?? {});
      if (
        Object.entries(p.selectorLabels).every(
          ([key, value]) => actual[key] === value,
        ) &&
        !verified.has(String(meta.uid))
      )
        fail();
    }
  }
  return verified;
}
