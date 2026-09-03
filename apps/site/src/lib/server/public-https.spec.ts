import type { LookupAddress } from 'node:dns';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const transportMocks = vi.hoisted(() => ({
  request: vi.fn(),
}));

vi.mock('node:https', () => ({
  request: transportMocks.request,
}));

import {
  assertIdentityContentEncoding,
  buildPublicHttpsResponse,
  createPinnedLookup,
  createPublicHttpsFetch,
  validatePublicHttpsUrl,
} from './public-https';

const publicAddress = { address: '93.184.216.34', family: 4 as const };

describe('public HTTPS guard', () => {
  it('rejects attacker-controlled invalid HTTP status codes', () => {
    expect(() =>
      buildPublicHttpsResponse(600, new Headers(), Buffer.from('bad status')),
    ).toThrow('server returned an invalid status');
  });

  it('discards bodies for statuses that Fetch requires to be bodyless', async () => {
    const response = buildPublicHttpsResponse(
      204,
      new Headers(),
      Buffer.from('unexpected body'),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('rejects encoded bodies when the server ignores identity encoding', () => {
    expect(() => assertIdentityContentEncoding('gzip')).toThrow(
      'ignored the identity encoding requirement',
    );
    expect(() => assertIdentityContentEncoding('identity')).not.toThrow();
  });

  it('terminates an encoded response instead of draining its body', async () => {
    const incoming = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      headers: { 'content-encoding': 'gzip' },
      resume: vi.fn(),
      statusCode: 200,
      statusMessage: 'OK',
    });
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      end: vi.fn(),
    });
    transportMocks.request.mockImplementation(
      (
        _url: URL,
        _options: unknown,
        callback: (response: typeof incoming) => void,
      ) => {
        request.end.mockImplementation(() => callback(incoming));
        return request;
      },
    );
    const guardedFetch = createPublicHttpsFetch({
      lookup: vi.fn(async () => [publicAddress]),
    });

    await expect(
      guardedFetch('https://jobs.example.com/encoded'),
    ).rejects.toThrow('ignored the identity encoding requirement');

    expect(incoming.resume).not.toHaveBeenCalled();
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(request.destroy).toHaveBeenCalledOnce();
  });

  it('honors the Node lookup all-address callback contract while pinning one address', () => {
    const lookup = createPinnedLookup(publicAddress);
    const callback = vi.fn();

    lookup('jobs.example.com', { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [publicAddress]);
  });

  it('honors the Node scalar lookup callback contract', () => {
    const lookup = createPinnedLookup(publicAddress);
    const callback = vi.fn();

    lookup('jobs.example.com', { all: false }, callback);

    expect(callback).toHaveBeenCalledWith(
      null,
      publicAddress.address,
      publicAddress.family,
    );
  });

  it('normalizes a trailing-dot hostname before applying the blocklist', async () => {
    const lookup = vi.fn(async () => [publicAddress]);

    await expect(
      validatePublicHttpsUrl('https://metadata.google.internal./x', lookup),
    ).rejects.toThrow('public DNS hostname');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects bracketed IPv6 literals before DNS resolution', async () => {
    const lookup = vi.fn(async () => [publicAddress]);

    await expect(
      validatePublicHttpsUrl('https://[::1]/private', lookup),
    ).rejects.toThrow('public DNS hostname');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a public-looking hostname when any DNS answer is private', async () => {
    const lookup = vi.fn(async () => [
      publicAddress,
      { address: '10.0.0.8', family: 4 as const },
    ]);

    await expect(
      validatePublicHttpsUrl('https://jobs.example.com/role', lookup),
    ).rejects.toThrow('outside the public internet');
  });

  it('rejects IPv6 transition addresses that can encapsulate private IPv4', async () => {
    const lookup = vi.fn(async () => [
      { address: '2002:0a00:0001::', family: 6 as const },
    ]);

    await expect(
      validatePublicHttpsUrl('https://jobs.example.com/role', lookup),
    ).rejects.toThrow('outside the public internet');
  });

  it.each([
    '2001:20::1',
    '2001:db8::1',
    '2620:4f:8000::1',
    '3fff::1',
  ])('rejects the special-use IPv6 address %s', async (address) => {
    const lookup = vi.fn(async () => [{ address, family: 6 as const }]);

    await expect(
      validatePublicHttpsUrl('https://jobs.example.com/role', lookup),
    ).rejects.toThrow('outside the public internet');
  });

  it('accepts an ordinary global-unicast IPv6 address', async () => {
    const lookup = vi.fn(async () => [
      { address: '2606:4700:4700::1111', family: 6 as const },
    ]);

    await expect(
      validatePublicHttpsUrl('https://jobs.example.com/role', lookup),
    ).resolves.toMatchObject({
      address: { address: '2606:4700:4700::1111', family: 6 },
    });
  });

  it('pins the validated address and validates every redirect target', async () => {
    const lookup = vi.fn(async (hostname: string) =>
      hostname === 'jobs.example.com'
        ? [publicAddress]
        : [{ address: '127.0.0.1', family: 4 as const }],
    );
    const transport = vi.fn(async () =>
      Response.redirect('https://redirect.example.com/internal', 302),
    );
    const guardedFetch = createPublicHttpsFetch({ lookup, transport });

    await expect(guardedFetch('https://jobs.example.com/role')).rejects.toThrow(
      'outside the public internet',
    );
    expect(transport).toHaveBeenCalledWith(
      new URL('https://jobs.example.com/role'),
      publicAddress,
      expect.any(Number),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('enforces one wall-clock deadline while DNS resolution is stalled', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(() => new Promise<never>(() => undefined));
      const guardedFetch = createPublicHttpsFetch({ lookup });
      const result = expect(
        guardedFetch('https://jobs.example.com/role'),
      ).rejects.toThrow('request timed out');

      await vi.advanceTimersByTimeAsync(15_001);

      await result;
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one fixed deadline across resolver fallback fetches', async () => {
    vi.useFakeTimers();
    try {
      const lookup = vi.fn(async () => [publicAddress]);
      const transport = vi.fn(
        async (_url: URL, _address: LookupAddress, _timeoutMs?: number) =>
          new Response('ok'),
      );
      const guardedFetch = createPublicHttpsFetch({
        deadlineAt: Date.now() + 15_000,
        lookup,
        transport,
      });

      await guardedFetch('https://jobs.example.com/first');
      await vi.advanceTimersByTimeAsync(10_000);
      await guardedFetch('https://jobs.example.com/fallback');

      const firstBudget = Number(transport.mock.calls[0]?.[2]);
      const secondBudget = Number(transport.mock.calls[1]?.[2]);
      expect(firstBudget).toBeGreaterThan(14_000);
      expect(secondBudget).toBeGreaterThan(4_000);
      expect(secondBudget).toBeLessThanOrEqual(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
