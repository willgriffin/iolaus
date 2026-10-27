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
