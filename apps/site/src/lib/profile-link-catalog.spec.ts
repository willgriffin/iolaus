import { describe, expect, it } from 'vitest';
import {
  PROFILE_LINK_PROVIDERS,
  providerForLink,
} from './profile-link-catalog.js';

describe('profile link catalog', () => {
  it('offers a broad curated catalog without provider records', () => {
    expect(PROFILE_LINK_PROVIDERS.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'linkedin',
        'github',
        'website',
        'instagram',
        'bluesky',
      ]),
    );
  });
  it('matches only approved exact hostnames and preserves unknown links as custom', () => {
    expect(providerForLink({ href: 'https://github.com/example' })?.id).toBe(
      'github',
    );
    expect(
      providerForLink({ href: 'https://github.com.evil.example/example' }),
    ).toBeUndefined();
    expect(
      providerForLink({ href: 'https://portfolio.example', label: 'Portfolio' })
        ?.id,
    ).toBe('website');
  });
});
