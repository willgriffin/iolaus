import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const siteSrc = join(import.meta.dirname, '..', '..');
const adminRoots = [
  join(siteSrc, 'routes', 'admin'),
  join(siteSrc, 'lib', 'components', 'admin'),
];
// POST targets that are `+server` endpoints rather than page actions. A native
// POST there gets a normal HTTP redirect, which `ssr = false` does not affect.
const serverEndpointActions = new Set(['/logout']);

function svelteFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return svelteFiles(path);
    return path.endsWith('.svelte') ? [path] : [];
  });
}

function unenhancedActionForms(): string[] {
  const offenders: string[] = [];
  for (const file of adminRoots.flatMap(svelteFiles)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<form\b([^>]*)>/gu)) {
      const attributes = match[1] ?? '';
      if (!/method=["']post["']/iu.test(attributes)) continue;
      if (/\buse:enhance\b/u.test(attributes)) continue;
      const action = /\baction=["']([^"']*)["']/u.exec(attributes)?.[1];
      if (action && serverEndpointActions.has(action)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${relative(siteSrc, file)}:${line}`);
    }
  }
  return offenders;
}

function resettingFormsWithSeededFields(): string[] {
  const offenders: string[] = [];
  for (const file of adminRoots.flatMap(svelteFiles)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /<form\b([^>]*)>([\s\S]*?)<\/form>/gu,
    )) {
      const [, attributes = '', body = ''] = match;
      // Only plain `use:enhance` resets the form after a successful action.
      if (!/\buse:enhance(?!=)/u.test(attributes)) continue;
      const seeded = [
        ...body.matchAll(/<(?:input|select|textarea)\b([^>]*)>/gu),
      ]
        .map((field) => field[1] ?? '')
        .filter((field) => !/type=["']hidden["']/u.test(field))
        .some((field) =>
          /\bbind:|\bvalue=\{|\bchecked=\{|\bselected=/u.test(field),
        );
      if (!seeded) continue;
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${relative(siteSrc, file)}:${line}`);
    }
  }
  return offenders;
}

describe('admin SPA rendering', () => {
  it('renders the admin tree client-side only', () => {
    const layout = readFileSync(
      join(siteSrc, 'routes', 'admin', '+layout.ts'),
      'utf8',
    );
    expect(layout).toMatch(/^export const ssr = false;$/mu);
    // Public pages keep server rendering: only the admin tree opts out.
    const root = readFileSync(join(siteSrc, 'routes', '+layout.ts'), 'utf8');
    expect(root).not.toMatch(/\bssr\b/u);
  });

  it('enhances every admin POST form that targets a page action', () => {
    expect(unenhancedActionForms()).toEqual([]);
  });

  it('keeps existing field values when an enhanced edit form succeeds', () => {
    // Default enhance resets fields before invalidated data re-renders, which
    // blanks forms that display saved values; they use keepFormValues.
    expect(resettingFormsWithSeededFields()).toEqual([]);
  });
});
