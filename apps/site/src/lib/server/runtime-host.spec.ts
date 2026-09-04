import { describe, expect, it } from 'vitest';
import { assertLocalLoopbackHost } from './runtime-host';

describe('local runtime host guard', () => {
  it.each(['127.0.0.1', 'localhost', '::1'])('accepts %s', (host) => {
    expect(() => assertLocalLoopbackHost(host)).not.toThrow();
  });

  it.each([
    undefined,
    null,
    true,
    false,
    '0.0.0.0',
    '192.168.1.2',
  ])('rejects a non-loopback bind (%s)', (host) => {
    expect(() => assertLocalLoopbackHost(host)).toThrow(
      'The local Iolaus server may only bind to loopback.',
    );
  });
});
