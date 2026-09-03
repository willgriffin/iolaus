import { describe, expect, it } from 'vitest';
import { safePdfFilename } from './http-headers';

describe('safePdfFilename', () => {
  it('removes control characters, quotes, and path separators', () => {
    expect(safePdfFilename('../Will\r\nContent-Length: 0/resume".pdf')).toBe(
      'Will Content-Length- 0-resume.pdf',
    );
  });

  it('falls back to resume.pdf when no safe stem remains', () => {
    expect(safePdfFilename('\n\t/')).toBe('resume.pdf');
  });

  it('normalizes the extension and clamps long filenames', () => {
    const filename = safePdfFilename(`${'a'.repeat(200)}.PDF`);

    expect(filename).toMatch(/\.pdf$/);
    expect(filename.length).toBe(120);
  });
});
