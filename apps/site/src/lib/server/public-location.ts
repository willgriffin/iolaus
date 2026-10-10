import {
  type GeoAdapter,
  getGeoAdapter,
  type Location,
} from '@happyvertical/geo';
import { z } from 'zod';
import { PublicSearchError } from './public-search/index.js';

const coordinateValue = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .min(1)
      .refine((value) => Number.isFinite(Number(value)))
      .transform(Number),
  ])
  .pipe(z.number().finite());
const coordinate = (min: number, max: number) =>
  coordinateValue.pipe(z.number().min(min).max(max));
export const publicLocationInputSchema = z
  .object({
    latitude: coordinate(-90, 90),
    longitude: coordinate(-180, 180),
  })
  .strict();

let geoAdapter: Promise<GeoAdapter> | undefined;
let reverseLookupActive = false;

function adapter() {
  geoAdapter ??= getGeoAdapter({
    provider: 'openstreetmap',
    maxResults: 1,
    rateLimitDelay: 1000,
    timeout: 2000,
    timezoneLookup: 'none',
    userAgent:
      'iolaus-public-location/1.0 (https://github.com/willgriffin/iolaus)',
  });
  return geoAdapter;
}

function locality(location: Location) {
  const components = location.addressComponents;
  if (!components || typeof components !== 'object') return null;
  const value =
    (typeof components.city === 'string' && components.city.trim()) ||
    (typeof components.region === 'string' && components.region.trim()) ||
    (typeof components.country === 'string' && components.country.trim());
  return value && value.length <= 120 ? value : null;
}

/**
 * Reverse geocodes only for the current request. Coordinates are neither
 * persisted nor logged. The process-scoped SDK adapter may keep a transient
 * provider cache and preserves its one-request-per-second provider limit.
 */
export async function reversePublicLocation(input: unknown) {
  const { latitude, longitude } = publicLocationInputSchema.parse(input);
  if (reverseLookupActive)
    throw new PublicSearchError(429, 'Location lookup is busy. Retry shortly.');
  reverseLookupActive = true;
  try {
    const [first] = await (await adapter()).reverseGeocode(latitude, longitude);
    const result = first ? locality(first) : null;
    if (!result) throw new PublicSearchError(503, 'Location is unavailable.');
    return { location: result };
  } finally {
    reverseLookupActive = false;
  }
}
