import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reverseGeocode: vi.fn(),
  getGeoAdapter: vi.fn(),
}));
vi.mock('@happyvertical/geo', () => ({
  getGeoAdapter: mocks.getGeoAdapter,
}));

import { reversePublicLocation } from './public-location.js';

beforeEach(() => {
  mocks.reverseGeocode.mockReset();
  mocks.getGeoAdapter.mockReset();
  mocks.getGeoAdapter.mockResolvedValue({
    reverseGeocode: mocks.reverseGeocode,
  });
});

it('returns a city without persisting coordinates or asking for timezone data', async () => {
  mocks.reverseGeocode.mockResolvedValue([
    {
      addressComponents: { city: 'Edmonton', region: 'Alberta' },
    },
  ]);
  await expect(
    reversePublicLocation({ latitude: 53.5461, longitude: -113.4938 }),
  ).resolves.toEqual({ location: 'Edmonton' });
  expect(mocks.getGeoAdapter).toHaveBeenCalledWith({
    provider: 'openstreetmap',
    maxResults: 1,
    rateLimitDelay: 1000,
    timeout: 2000,
    timezoneLookup: 'none',
    userAgent:
      'iolaus-public-location/1.0 (https://github.com/willgriffin/iolaus)',
  });
  expect(mocks.reverseGeocode).toHaveBeenCalledWith(53.5461, -113.4938);
});

it('rejects invalid coordinates before calling the provider', async () => {
  await expect(
    reversePublicLocation({ latitude: 91, longitude: -113.4938 }),
  ).rejects.toThrow();
  expect(mocks.reverseGeocode).not.toHaveBeenCalled();
  await expect(
    reversePublicLocation({ latitude: '', longitude: '-113.4938' }),
  ).rejects.toThrow();
});

it('rejects concurrent lookups instead of queuing coordinates', async () => {
  let resolve!: (value: unknown[]) => void;
  mocks.reverseGeocode.mockReturnValue(
    new Promise<unknown[]>((done) => {
      resolve = done;
    }),
  );
  const first = reversePublicLocation({ latitude: 53.5, longitude: -113.5 });
  await expect(
    reversePublicLocation({ latitude: 53.5, longitude: -113.5 }),
  ).rejects.toMatchObject({ status: 429 });
  resolve([{ addressComponents: { city: 'Edmonton' } }]);
  await expect(first).resolves.toEqual({ location: 'Edmonton' });
});

it('uses a region when the provider has no city and refuses empty results', async () => {
  mocks.reverseGeocode.mockResolvedValueOnce([
    { addressComponents: { region: 'Alberta' } },
  ]);
  await expect(
    reversePublicLocation({ latitude: 53.5, longitude: -113.5 }),
  ).resolves.toEqual({ location: 'Alberta' });
  mocks.reverseGeocode.mockResolvedValueOnce([]);
  await expect(
    reversePublicLocation({ latitude: 53.5, longitude: -113.5 }),
  ).rejects.toMatchObject({ status: 503 });
});
