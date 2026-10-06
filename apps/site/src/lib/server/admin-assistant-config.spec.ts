import { describe, expect, it } from 'vitest';
import { isAdminAssistantEnabled } from './admin-assistant-config';

describe('admin assistant opt-in', () => {
  it.each([
    undefined,
    '',
    'false',
    '1',
    'yes',
    'enabled',
  ])('defaults off for %s', (value) => {
    expect(isAdminAssistantEnabled({ IOLAUS_ASSISTANT_ENABLED: value })).toBe(
      false,
    );
  });
  it('requires an explicit true value', () => {
    expect(isAdminAssistantEnabled({ IOLAUS_ASSISTANT_ENABLED: 'true' })).toBe(
      true,
    );
    expect(
      isAdminAssistantEnabled({ IOLAUS_ASSISTANT_ENABLED: ' TRUE ' }),
    ).toBe(true);
  });
});
