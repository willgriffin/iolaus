const LOCAL_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Fail closed before a local owner-bootstrap runtime can serve on the network. */
export function assertLocalLoopbackHost(
  host: string | boolean | null | undefined,
): asserts host is string {
  if (typeof host !== 'string' || !LOCAL_LOOPBACK_HOSTS.has(host)) {
    throw new Error('The local Iolaus server may only bind to loopback.');
  }
}
