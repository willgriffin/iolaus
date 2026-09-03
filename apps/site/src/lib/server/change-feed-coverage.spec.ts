import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for issue #456.
 *
 * #436 requires every raw `database.update('opportunities', …)` — a write that
 * goes around `save()` and so is invisible to the change-feed interceptor — to
 * record a bump via `change-feed.ts`. Three such writers were still
 * missed after `837360e`, and a fourth existed that the review never named, so
 * a spec that only asserts today's call sites would not stop the next one.
 *
 * This scans the source instead: any raw opportunity writer that does not bump
 * inside its own function fails the suite, naming the file and line.
 */

const SERVER_DIR = join(import.meta.dirname, '.');

/** Names that count as recording the write. */
const BUMP_CALLS = [
  'bumpOpportunityChangeFeed',
  'bumpOpportunityTableChangeFeed',
];

/**
 * Matches an actual invocation, not the bare name. A substring test would let
 * a mention in a comment, a string, or a commented-out line satisfy the guard
 * while nothing bumps at runtime, so the guard would pass on exactly the
 * regression it exists to catch.
 */
const BUMP_CALL_PATTERN = new RegExp(`\\b(?:${BUMP_CALLS.join('|')})\\s*\\(`);

/** Strip line and block comments so a mention in prose cannot satisfy the guard. */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.spec.ts') || entry.endsWith('.d.ts')) continue;
    found.push(path);
  }
  return found;
}

/**
 * Line numbers of `.update('opportunities', …)` calls, allowing the table name
 * to sit on the call line or the line after it (Biome wraps these).
 */
function rawOpportunityWriterLines(lines: string[]): number[] {
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\.update\(/.test(line)) continue;
    const sameLine = /\.update\(\s*['"]opportunities['"]/.test(line);
    const nextLine =
      /\.update\(\s*$/.test(line) &&
      /^\s*['"]opportunities['"]\s*,?\s*$/.test(lines[index + 1] ?? '');
    if (sameLine || nextLine) hits.push(index);
  }
  return hits;
}

/**
 * End of the enclosing top-level function: the next line that closes at column
 * zero. Every raw opportunity writer is a top-level `async function`, so this
 * bounds the search without needing a parser.
 */
function endOfEnclosingFunction(lines: string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if (/^}/.test(lines[index])) return index;
  }
  return lines.length - 1;
}

describe('raw opportunity writers bump the change feed', () => {
  it('has no raw opportunities update without a bump', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SERVER_DIR)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const index of rawOpportunityWriterLines(lines)) {
        const end = endOfEnclosingFunction(lines, index);
        const body = withoutComments(lines.slice(index, end + 1).join('\n'));
        if (BUMP_CALL_PATTERN.test(body)) continue;
        offenders.push(
          `${path.slice(path.indexOf('apps/site'))}:${index + 1} — raw database.update('opportunities', …) with no ${BUMP_CALLS[0]} call in its function. See issue #436.`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('actually finds the known raw writers, so the scan cannot silently match nothing', () => {
    const counted = sourceFiles(SERVER_DIR).reduce(
      (total, path) =>
        total +
        rawOpportunityWriterLines(readFileSync(path, 'utf8').split('\n'))
          .length,
      0,
    );
    expect(counted).toBeGreaterThanOrEqual(6);
  });

  it('does not accept a mention in a comment as a bump', () => {
    const mentioned = withoutComments(
      [
        '  // bumpOpportunityChangeFeed(database, [id]);',
        '  /* bumpOpportunityTableChangeFeed(database, 1); */',
        '  return result.affected > 0;',
      ].join('\n'),
    );
    expect(BUMP_CALL_PATTERN.test(mentioned)).toBe(false);

    const called = withoutComments(
      '  await bumpOpportunityChangeFeed(db, ids);',
    );
    expect(BUMP_CALL_PATTERN.test(called)).toBe(true);
  });
});
