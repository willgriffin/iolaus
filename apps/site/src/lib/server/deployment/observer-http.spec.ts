import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ readFile: vi.fn(), request: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: native.readFile }));
vi.mock('node:https', () => ({ request: native.request }));

import { observeWriterExclusion } from './observer.js';

const projection = '/var/run/secrets/kubernetes.io/serviceaccount';
const identity = {
  application: 'iolaus',
  environment: 'test',
  release: 'r1',
  attempt: 'a1',
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
        'smrt.happyvertical.com/attempt': 'a1',
      },
      ownerReferences: [
        {
          kind: 'Job',
          name: 'site-migration-r1-a1',
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
          { metadata: metadata('site-migration-r1-a1', 'job-1') },
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

describe('native Kubernetes observer HTTP/parsing boundary', () => {
  let inventory: ReturnType<typeof rawInventory>;
  let token: string;
  beforeEach(() => {
    inventory = rawInventory();
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
                  statusCode: 200,
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
    expect(native.readFile.mock.calls.map(([path]) => path).sort()).toEqual(
      ['token', 'ca.crt', 'namespace', 'pod-name', 'pod-uid']
        .map((name) => `${projection}/${name}`)
        .sort(),
    );
    token = 'projected-token-2';
    await observeWriterExclusion(identity);
    expect(native.readFile).toHaveBeenCalledTimes(10);
    expect(native.request.mock.calls.at(-1)?.[0].headers.authorization).toBe(
      'Bearer projected-token-2',
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
      'Missing projection',
    );
    expect(native.request).not.toHaveBeenCalled();
  });
});
