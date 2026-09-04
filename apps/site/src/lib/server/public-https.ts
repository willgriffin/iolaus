import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { getConfiguredUserAgent } from './app-config.js';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const PUBLIC_HTTPS_TIMEOUT_MS = 15_000;
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);
const SPECIAL_USE_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
] as const) {
  SPECIAL_USE_IPV6.addSubnet(network, prefix, 'ipv6');
}

type Lookup = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]>;

export type PublicHttpsTransport = (
  url: URL,
  address: LookupAddress,
  timeoutMs?: number,
) => Promise<Response>;

export function createPinnedLookup(
  address: LookupAddress,
): NonNullable<RequestOptions['lookup']> {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function publicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second, third] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224)
    return false;
  if (first === 100 && second >= 64 && second <= 127) return false;
  if (first === 169 && second === 254) return false;
  if (first === 172 && second >= 16 && second <= 31) return false;
  if (first === 192 && second === 0 && third === 0) return false;
  if (first === 192 && second === 0 && third === 2) return false;
  if (first === 192 && second === 88 && third === 99) return false;
  if (first === 192 && second === 168) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  if (first === 198 && second === 51 && third === 100) return false;
  if (first === 203 && second === 0 && third === 113) return false;
  return true;
}

function publicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  // Restrict imports to the currently allocated global-unicast range. This
  // rejects loopback, link-local, unique-local, multicast, IPv4-mapped, and
  // unspecified addresses. Conservatively reject every IANA special-purpose
  // allocation inside 2000::/3 as well: even entries described as globally
  // reachable are protocol-specific rather than ordinary public destinations.
  if (!(normalized.startsWith('2') || normalized.startsWith('3'))) return false;
  return !SPECIAL_USE_IPV6.check(normalized, 'ipv6');
}

function publicAddress(address: LookupAddress): boolean {
  if (address.family === 4) return publicIpv4(address.address);
  if (address.family === 6) return publicIpv6(address.address);
  return false;
}

function publicUrlError(message: string): Error {
  return new Error(`Unsafe posting URL: ${message}`);
}

/** Build a Fetch-compatible response from an already bounded HTTPS payload. */
export function buildPublicHttpsResponse(
  status: number,
  headers: Headers,
  body: Buffer,
  statusText?: string,
): Response {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw publicUrlError('the server returned an invalid status.');
  }
  return new Response(
    [204, 205, 304].includes(status) || body.length === 0
      ? null
      : Uint8Array.from(body),
    { headers, status, statusText },
  );
}

export function assertIdentityContentEncoding(value: unknown): void {
  const contentEncoding = String(value ?? '')
    .trim()
    .toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    throw publicUrlError(
      'the server ignored the identity encoding requirement.',
    );
  }
}

export async function validatePublicHttpsUrl(
  input: string | URL,
  lookup: Lookup = dnsLookup as Lookup,
  deadlineAt?: number,
): Promise<{ address: LookupAddress; url: URL }> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input) : new URL(input);
  } catch {
    throw publicUrlError('expected a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw publicUrlError('HTTPS is required.');
  }
  if (url.username || url.password) {
    throw publicUrlError('credentials are not allowed.');
  }

  const hostname = normalizedHostname(url);
  if (
    !hostname ||
    BLOCKED_HOSTS.has(hostname) ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isIP(hostname) !== 0
  ) {
    throw publicUrlError('a public DNS hostname is required.');
  }
  url.hostname = hostname;

  const resolution = lookup(hostname, { all: true, verbatim: true }).catch(
    () => {
      throw publicUrlError('the hostname could not be resolved.');
    },
  );
  const addresses = deadlineAt
    ? await beforeDeadline(resolution, deadlineAt)
    : await resolution;
  if (
    addresses.length === 0 ||
    addresses.some((address) => !publicAddress(address))
  ) {
    throw publicUrlError('the hostname resolved outside the public internet.');
  }
  return { address: addresses[0], url };
}

async function pinnedHttpsTransport(
  url: URL,
  address: LookupAddress,
  timeoutMs = PUBLIC_HTTPS_TIMEOUT_MS,
): Promise<Response> {
  return await new Promise<Response>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      action();
    };
    const request = httpsRequest(
      url,
      {
        headers: {
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
          'accept-encoding': 'identity',
          'user-agent': getConfiguredUserAgent('job-posting importer'),
        },
        lookup: createPinnedLookup(address),
        method: 'GET',
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (!Number.isInteger(status) || status < 200 || status > 599) {
          settle(() =>
            reject(publicUrlError('the server returned an invalid status.')),
          );
          incoming.destroy();
          request.destroy();
          return;
        }
        try {
          assertIdentityContentEncoding(incoming.headers['content-encoding']);
        } catch (cause) {
          settle(() => reject(cause));
          incoming.destroy();
          request.destroy();
          return;
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > MAX_RESPONSE_BYTES) {
            incoming.destroy(publicUrlError('the response exceeded 5 MiB.'));
            return;
          }
          chunks.push(buffer);
        });
        incoming.on('error', (cause) => settle(() => reject(cause)));
        incoming.on('end', () => {
          const body = Buffer.concat(chunks);
          try {
            const response = buildPublicHttpsResponse(
              status,
              headers,
              body,
              incoming.statusMessage,
            );
            settle(() => resolve(response));
          } catch (cause) {
            settle(() => reject(cause));
          }
        });
      },
    );
    deadline = setTimeout(
      () => {
        request.destroy(publicUrlError('the request timed out.'));
      },
      Math.max(1, timeoutMs),
    );
    request.on('error', (cause) => settle(() => reject(cause)));
    request.end();
  });
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw publicUrlError('the request timed out.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(publicUrlError('the request timed out.')),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createPublicHttpsFetch(
  options: {
    deadlineAt?: number;
    lookup?: Lookup;
    transport?: PublicHttpsTransport;
  } = {},
): typeof fetch {
  const lookup = options.lookup ?? (dnsLookup as Lookup);
  const transport = options.transport ?? pinnedHttpsTransport;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const deadlineAt =
      options.deadlineAt ?? Date.now() + PUBLIC_HTTPS_TIMEOUT_MS;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      throw publicUrlError('only GET requests are allowed.');
    }
    let target =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input
          : String(input);

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const resolved = await beforeDeadline(
        validatePublicHttpsUrl(target, lookup),
        deadlineAt,
      );
      const response = await beforeDeadline(
        transport(
          resolved.url,
          resolved.address,
          Math.max(1, deadlineAt - Date.now()),
        ),
        deadlineAt,
      );
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (redirect === MAX_REDIRECTS) {
        throw publicUrlError('too many redirects.');
      }
      target = new URL(location, resolved.url).toString();
    }
    throw publicUrlError('too many redirects.');
  }) as typeof fetch;
}
