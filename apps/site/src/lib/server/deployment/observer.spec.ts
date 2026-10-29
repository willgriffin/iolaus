import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertWriterExclusion,
  maintenanceObserverPolicy,
  type ObserverSnapshot,
  releaseIdentity,
} from './observer.js';

const identity = {
  application: 'iolaus',
  environment: 'test',
  release: 'r1',
  attempt: 'a1',
};
function fixture(): ObserverSnapshot {
  const labels = {
    'app.kubernetes.io/instance': 'site',
    'app.kubernetes.io/name': 'iolaus',
    'smrt.happyvertical.com/environment': 'test',
    'smrt.happyvertical.com/release': 'r1',
    'smrt.happyvertical.com/attempt': 'a1',
    'smrt.happyvertical.com/component': 'migration',
  };
  return {
    namespace: 'test',
    podName: 'migrator',
    podUid: 'pod-1',
    objects: [
      {
        kind: 'Pod',
        metadata: {
          name: 'migrator',
          uid: 'pod-1',
          namespace: 'test',
          labels,
          ownerReferences: [
            {
              kind: 'Job',
              name: 'site-migration-r1-a1',
              uid: 'job-1',
              controller: true,
            },
          ],
        },
        status: { phase: 'Running' },
      },
      {
        kind: 'Job',
        metadata: {
          name: 'site-migration-r1-a1',
          uid: 'job-1',
          namespace: 'test',
          labels,
        },
      },
      {
        kind: 'Deployment',
        metadata: { name: 'site-web', uid: 'web', namespace: 'test', labels },
        spec: { replicas: 0 },
        status: { replicas: 0 },
      },
    ],
  };
}
describe('fresh writer inventory decision', () => {
  it('accepts the identified maintenance pod with drained controllers', () =>
    expect(() => assertWriterExclusion(fixture(), identity)).not.toThrow());
  it.each([
    'Pending',
    'Running',
    'Unknown',
    undefined,
  ])('refuses another %s writer pod', (phase) => {
    const snapshot = fixture();
    snapshot.objects.push({
      ...snapshot.objects[0],
      metadata: {
        ...snapshot.objects[0].metadata,
        name: 'writer',
        uid: 'writer',
      },
      status: { phase },
    });
    expect(() => assertWriterExclusion(snapshot, identity)).toThrow(
      /writer Pod/,
    );
  });
  it('refuses stale identity, unknown workloads and terminating writers', () => {
    const stale = fixture();
    stale.podUid = 'old';
    expect(() => assertWriterExclusion(stale, identity)).toThrow(/identity/);
    const unknown = fixture();
    unknown.objects[2].metadata.labels = {};
    expect(() => assertWriterExclusion(unknown, identity)).toThrow(/Unknown/);
    const terminating = fixture();
    terminating.objects[2].metadata.deletionTimestamp = 'now';
    expect(() => assertWriterExclusion(terminating, identity)).toThrow(
      /Terminating/,
    );
  });
  it('refuses unsupported writers even when apparently idle', () => {
    const snapshot = fixture();
    snapshot.objects[2].kind = 'StatefulSet';
    expect(() => assertWriterExclusion(snapshot, identity)).toThrow(
      /Unsupported/,
    );
  });
  it('accepts a retained terminal failed migration and refuses a pending Job', () => {
    const snapshot = fixture();
    const previous = {
      ...snapshot.objects[1],
      metadata: {
        ...snapshot.objects[1].metadata,
        name: 'site-migration-r1-old',
        uid: 'previous',
      },
      status: { active: 0, conditions: [{ type: 'Failed', status: 'True' }] },
    };
    snapshot.objects.push(previous);
    expect(() => assertWriterExclusion(snapshot, identity)).not.toThrow();
    previous.status.conditions = [];
    expect(() => assertWriterExclusion(snapshot, identity)).toThrow(
      /nonterminal/,
    );
  });
  it('requires chart release identity, never passed quiescent flags', () => {
    expect(() => releaseIdentity({ SMRT_APP_NAME: 'iolaus' })).toThrow(
      /SMRT_APP_ENVIRONMENT/,
    );
  });
});

describe('chart maintenance nonwriter exception', () => {
  function maintained() {
    const snapshot = fixture();
    const config =
      "server { listen 8080; location / { return 503 'maintenance'; } }\n";
    const policy = maintenanceObserverPolicy(
      JSON.stringify({
        releaseName: 'site',
        image: `nginx@sha256:${'1'.repeat(64)}`,
        configSha256: createHash('sha256').update(config).digest('hex'),
        serviceAccountName: 'default',
        migrationServiceAccountName: 'observer',
      }),
    );
    const labels = {
      ...snapshot.objects[1].metadata.labels,
      'smrt.happyvertical.com/phase': 'migrate',
      'smrt.happyvertical.com/component': 'maintenance',
    };
    const spec = {
      automountServiceAccountToken: false,
      serviceAccountName: 'default',
      containers: [
        {
          image: policy.image,
          command: ['nginx', '-g', 'daemon off;'],
          volumeMounts: [
            { name: 'config', mountPath: '/etc/nginx/conf.d', readOnly: true },
          ],
        },
      ],
      volumes: [{ name: 'config', configMap: { name: 'site-maintenance' } }],
    };
    snapshot.objects[0].spec = {
      serviceAccountName: 'observer',
      automountServiceAccountToken: false,
    };
    snapshot.maintenanceConfig = {
      kind: 'ConfigMap',
      metadata: {
        name: 'site-maintenance',
        uid: 'cm',
        namespace: 'test',
        labels,
      },
      data: { 'default.conf': config },
    };
    snapshot.objects.push(
      {
        kind: 'Deployment',
        metadata: {
          name: 'site-maintenance',
          uid: 'maintenance',
          namespace: 'test',
          labels,
        },
        spec: { replicas: 1, template: { spec } },
      },
      {
        kind: 'ReplicaSet',
        metadata: {
          name: 'maintenance-rs',
          uid: 'maintenance-rs',
          namespace: 'test',
          labels,
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
      },
      {
        kind: 'Pod',
        metadata: {
          name: 'maintenance-pod',
          uid: 'maintenance-pod',
          namespace: 'test',
          labels,
          ownerReferences: [
            {
              kind: 'ReplicaSet',
              name: 'maintenance-rs',
              uid: 'maintenance-rs',
              controller: true,
            },
          ],
        },
        spec,
        status: { phase: 'Running' },
      },
    );
    return { snapshot, policy };
  }
  it('allows exact chart responder through its immutable owner chain', () => {
    const { snapshot, policy } = maintained();
    expect(() =>
      assertWriterExclusion(snapshot, identity, policy),
    ).not.toThrow();
  });
  it('refuses changed ConfigMap bytes, image, credentials, owner UID or SA', () => {
    for (const mutate of [
      (snapshot: ObserverSnapshot) => {
        if (snapshot.maintenanceConfig?.data)
          snapshot.maintenanceConfig.data['default.conf'] += 'changed';
      },
      (snapshot: ObserverSnapshot) => {
        const pod = snapshot.objects.at(-1);
        if (pod?.spec?.containers?.[0])
          pod.spec.containers[0].image = `other@sha256:${'2'.repeat(64)}`;
      },
      (snapshot: ObserverSnapshot) => {
        const pod = snapshot.objects.at(-1);
        if (pod?.spec?.containers?.[0])
          pod.spec.containers[0].env = [
            { name: 'DATABASE_URL', value: 'sensitive' },
          ];
      },
      (snapshot: ObserverSnapshot) => {
        const pod = snapshot.objects.at(-1);
        if (pod)
          pod.metadata.ownerReferences = [
            {
              kind: 'ReplicaSet',
              name: 'maintenance-rs',
              uid: 'old',
              controller: true,
            },
          ];
      },
      (snapshot: ObserverSnapshot) => {
        if (snapshot.objects[0].spec)
          snapshot.objects[0].spec.serviceAccountName = 'other';
      },
    ]) {
      const { snapshot, policy } = maintained();
      mutate(snapshot);
      expect(() => assertWriterExclusion(snapshot, identity, policy)).toThrow();
    }
  });
  it('requires a strict policy instead of a nonwriter boolean', () => {
    expect(() => maintenanceObserverPolicy('{"writer":false}')).toThrow(
      /policy/,
    );
    expect(() => maintenanceObserverPolicy('')).toThrow(/policy/);
  });
});

describe('native dormant ReplicaSet history after parent adoption', () => {
  function retained() {
    const snapshot = fixture();
    snapshot.namespace = 'jobgeni';
    for (const object of snapshot.objects) {
      object.metadata.namespace = 'jobgeni';
      if (object.metadata.labels)
        object.metadata.labels['app.kubernetes.io/instance'] = 'jobgeni';
    }
    snapshot.objects[1].metadata.name = 'jobgeni-migration-r1-a1';
    const migrationOwner = snapshot.objects[0].metadata.ownerReferences?.[0];
    if (migrationOwner) migrationOwner.name = 'jobgeni-migration-r1-a1';
    const parent = snapshot.objects[2];
    parent.apiVersion = 'apps/v1';
    parent.metadata.name = 'jobgeni-schedule-worker';
    parent.metadata.uid = 'f47979fc-b9d9-4432-aa60-554f516e93ee';
    const old: ObserverSnapshot['objects'][number] = {
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      metadata: {
        name: 'jobgeni-schedule-worker-5f5577f896',
        uid: '5c5c4444-b6fc-457e-87da-82018f4e0c1f',
        namespace: 'jobgeni',
        labels: {
          appName: 'jobgeni-schedule-worker',
          'pod-template-hash': '5f5577f896',
        },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: parent.metadata.name,
            uid: parent.metadata.uid,
            controller: true,
            blockOwnerDeletion: true,
          },
        ],
      },
      spec: {
        replicas: 0,
        template: {
          spec: {
            containers: [
              {
                image: `ghcr.io/willgriffin/iolaus/site@sha256:${'1'.repeat(64)}`,
              },
            ],
          },
        },
      },
      status: { replicas: 0 },
    };
    snapshot.objects.push(old);
    return { snapshot, old, parent };
  }
  function set(raw: unknown, path: string, value: unknown) {
    let current = raw as Record<string, unknown>;
    const parts = path.split('.');
    for (const part of parts.slice(0, -1))
      current = current[part] as Record<string, unknown>;
    current[parts[parts.length - 1]] = value;
  }
  it('accepts retained native zero ReplicaSet without instance label after parent adoption', () => {
    const f = retained();
    expect(() => assertWriterExclusion(f.snapshot, identity)).not.toThrow();
  });
  it('accepts explicit zero ready counters and absent labels only through the verified parent', () => {
    const f = retained();
    f.old.metadata.labels = undefined;
    f.old.status = {
      replicas: 0,
      readyReplicas: 0,
      availableReplicas: 0,
      fullyLabeledReplicas: 0,
    };
    expect(() => assertWriterExclusion(f.snapshot, identity)).not.toThrow();
  });
  it.each([
    ['apiVersion', 'extensions/v1beta1'],
    ['metadata.namespace', 'foreign'],
    ['metadata.uid', ''],
    ['metadata.name', ''],
    ['metadata.name', 'invalid..name'],
    ['metadata.deletionTimestamp', 'now'],
    ['metadata.labels', { 'app.kubernetes.io/instance': 'foreign' }],
    ['metadata.labels', { 'app.kubernetes.io/instance': '' }],
    ['metadata.labels', { 'app.kubernetes.io/instance': null }],
    ['metadata.labels', { 'app.kubernetes.io/instance': undefined }],
    ['metadata.labels', null],
    ['spec.replicas', 1],
    ['spec.replicas', undefined],
    ['spec.replicas', '0'],
    ['status', undefined],
    ['status', []],
    ['spec', []],
    ['status.replicas', 1],
    ['status.replicas', undefined],
    ['status.replicas', null],
    ['status.readyReplicas', 1],
    ['status.readyReplicas', null],
    ['status.availableReplicas', 1],
    ['status.fullyLabeledReplicas', 1],
    ['metadata.ownerReferences', []],
    ['metadata.ownerReferences.0.uid', 'foreign'],
    ['metadata.ownerReferences.0.name', 'other'],
    ['metadata.ownerReferences.0.apiVersion', 'v1'],
    ['metadata.ownerReferences.0.kind', 'StatefulSet'],
    ['metadata.ownerReferences.0.controller', false],
    ['metadata.ownerReferences.0.blockOwnerDeletion', 'true'],
    ['metadata.ownerReferences.0', null],
  ])('denies unsafe or malformed retained RS %s', (path, value) => {
    const f = retained();
    set(f.old, path, value);
    expect(() => assertWriterExclusion(f.snapshot, identity)).toThrow();
  });
  it.each([
    ['metadata.namespace', 'foreign'],
    ['metadata.uid', 'recreated-parent'],
    ['metadata.labels', { 'app.kubernetes.io/instance': 'foreign' }],
    ['metadata.deletionTimestamp', 'now'],
    ['apiVersion', 'extensions/v1beta1'],
  ])('denies unverified adopted parent %s', (path, value) => {
    const f = retained();
    set(f.parent, path, value);
    expect(() => assertWriterExclusion(f.snapshot, identity)).toThrow();
  });
  it('denies multiple owners and ambiguous duplicate parent identities', () => {
    const f = retained();
    f.old.metadata.ownerReferences?.push({
      ...f.old.metadata.ownerReferences[0],
    });
    expect(() => assertWriterExclusion(f.snapshot, identity)).toThrow();
    const duplicate = retained();
    duplicate.snapshot.objects.push(structuredClone(duplicate.parent));
    expect(() => assertWriterExclusion(duplicate.snapshot, identity)).toThrow();
  });
  it('still denies a live child of an otherwise eligible dormant legacy RS', () => {
    const f = retained();
    f.snapshot.objects.push({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: 'old-live-child',
        uid: 'old-live-child',
        namespace: 'jobgeni',
        labels: { 'app.kubernetes.io/instance': 'jobgeni' },
        ownerReferences: [
          {
            apiVersion: 'apps/v1',
            kind: 'ReplicaSet',
            name: f.old.metadata.name,
            uid: f.old.metadata.uid,
            controller: true,
          },
        ],
      },
      status: { phase: 'Running' },
    });
    expect(() => assertWriterExclusion(f.snapshot, identity)).toThrow(
      /writer Pod/,
    );
  });
});
