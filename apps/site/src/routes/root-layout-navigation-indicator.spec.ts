import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const layout = readFileSync(
  new URL('./+layout.svelte', import.meta.url),
  'utf8',
);

describe('root layout navigation indicator', () => {
  it('shows a progress bar as soon as a client navigation starts', () => {
    expect(layout).toMatch(/import \{ navigating, page \} from '\$app\/state'/);
    expect(layout).toContain('Boolean(navigating.to)');
    expect(layout).toMatch(
      /\{#if isNavigating\}\s*<!--[\s\S]*?-->\s*<div class="nav-progress"/,
    );
  });

  it('keeps the bar decorative so route status regions stay unique', () => {
    expect(layout).toContain('<div class="nav-progress" aria-hidden="true">');
    expect(layout).not.toMatch(/nav-progress"[^>]*role="status"/);
  });
});
