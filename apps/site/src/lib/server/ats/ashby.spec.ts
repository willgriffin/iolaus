import { describe, expect, it, vi } from 'vitest';
import {
  ashbySubmitter,
  extractAshbyQuestions,
  isAshbyFileQuestion,
  parseAshbyUrl,
} from './ashby.js';
import type { AtsFilePart, AtsFormSchema } from './types.js';

// A trimmed posting page: the embedded SSR payload with the application form
// definition Ashby's hosted board hydrates from. Mirrors the real shape
// (sections[].fields[].field {path,title,type} + isRequired).
function postingHtml(): string {
  const appData = {
    posting: {
      id: 'job-1',
      applicationForm: {
        formDefinition: {
          sections: [
            {
              fields: [
                {
                  field: {
                    id: 'f1',
                    path: '_systemfield_name',
                    title: 'Name',
                    type: 'String',
                  },
                  isRequired: true,
                },
                {
                  field: {
                    id: 'f2',
                    path: '_systemfield_resume',
                    title: 'Resume',
                    type: 'File',
                  },
                  isRequired: false,
                },
              ],
            },
            {
              fields: [
                {
                  field: {
                    id: 'f3',
                    path: 'abc-123',
                    title: 'Why this role?',
                    type: 'LongText',
                  },
                  isRequired: true,
                },
              ],
            },
          ],
        },
      },
      // A second form definition (survey) must NOT be picked up — only the
      // application form's questions are part of the schema.
      surveyForms: [{ formDefinition: { sections: [] } }],
    },
  };
  return `<!doctype html><script>window.__appData = ${JSON.stringify(
    appData,
  )};</script>`;
}

function htmlResponse(body: string, ok = true): Response {
  return {
    ok,
    text: async () => body,
  } as unknown as Response;
}

describe('parseAshbyUrl', () => {
  it('parses the canonical posting URL', () => {
    expect(
      parseAshbyUrl('https://jobs.ashbyhq.com/acme/7458d4e9-uuid'),
    ).toEqual({ boardToken: 'acme', jobId: '7458d4e9-uuid' });
  });

  it('ignores an /application suffix and query string', () => {
    expect(
      parseAshbyUrl('https://jobs.ashbyhq.com/acme/job-1/application?utm=x'),
    ).toEqual({ boardToken: 'acme', jobId: 'job-1' });
  });

  it('rejects lookalike hosts', () => {
    expect(
      parseAshbyUrl('https://jobs.ashbyhq.com.evil.com/acme/job-1'),
    ).toBeNull();
    expect(parseAshbyUrl('https://jobs.notashbyhq.com/acme/job-1')).toBeNull();
  });

  it('returns null when the job id is missing', () => {
    expect(parseAshbyUrl('https://jobs.ashbyhq.com/acme')).toBeNull();
  });

  it('returns null for malformed urls', () => {
    expect(parseAshbyUrl('not a url')).toBeNull();
  });
});

describe('ashbySubmitter.supports', () => {
  it('matches ashby case-insensitively and nothing else', () => {
    expect(ashbySubmitter.supports('ashby')).toBe(true);
    expect(ashbySubmitter.supports('Ashby')).toBe(true);
    expect(ashbySubmitter.supports('greenhouse')).toBe(false);
    expect(ashbySubmitter.supports('')).toBe(false);
  });
});

describe('ashbySubmitter.matchesUrl', () => {
  const schema: AtsFormSchema = {
    ats: 'ashby',
    boardToken: 'acme',
    jobId: 'job-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [],
  };

  it('matches when board slug and job id agree with the URL', () => {
    expect(
      ashbySubmitter.matchesUrl(schema, 'https://jobs.ashbyhq.com/acme/job-1'),
    ).toBe(true);
  });

  it('rejects a different job id (stale schema)', () => {
    expect(
      ashbySubmitter.matchesUrl(schema, 'https://jobs.ashbyhq.com/acme/job-9'),
    ).toBe(false);
  });

  it('rejects a different board slug', () => {
    expect(
      ashbySubmitter.matchesUrl(schema, 'https://jobs.ashbyhq.com/other/job-1'),
    ).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(ashbySubmitter.matchesUrl(schema, 'not a url')).toBe(false);
  });
});

describe('extractAshbyQuestions', () => {
  it('flattens all application-form sections into questions', () => {
    expect(extractAshbyQuestions(postingHtml())).toEqual([
      {
        id: '_systemfield_name',
        label: 'Name',
        required: true,
        type: 'String',
      },
      {
        id: '_systemfield_resume',
        label: 'Resume',
        required: false,
        type: 'File',
      },
      {
        id: 'abc-123',
        label: 'Why this role?',
        required: true,
        type: 'LongText',
      },
    ]);
  });

  it('returns null when there is no embedded application form', () => {
    expect(extractAshbyQuestions('<html>no app data</html>')).toBeNull();
    expect(extractAshbyQuestions(undefined)).toBeNull();
    expect(extractAshbyQuestions('')).toBeNull();
  });
});

describe('ashbySubmitter.fetchFormSchema', () => {
  it('fetches the posting page and maps the embedded form definition', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(postingHtml()));

    const schema = await ashbySubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Normalizes to the canonical posting page (drops /application + query).
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://jobs.ashbyhq.com/acme/job-1',
    );
    expect(schema?.ats).toBe('ashby');
    expect(schema?.boardToken).toBe('acme');
    expect(schema?.jobId).toBe('job-1');
    expect(schema?.questions.map((q) => q.id)).toEqual([
      '_systemfield_name',
      '_systemfield_resume',
      'abc-123',
    ]);
  });

  it('returns null when the URL is not ashby', async () => {
    const fetchImpl = vi.fn();
    const schema = await ashbySubmitter.fetchFormSchema({
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      fetchImpl,
    });
    expect(schema).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('forbidden', false));
    const schema = await ashbySubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.ashbyhq.com/acme/job-1',
      fetchImpl,
    });
    expect(schema).toBeNull();
  });

  it('returns null when the page has no embedded form', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('<html>no form</html>'));
    const schema = await ashbySubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.ashbyhq.com/acme/job-1',
      fetchImpl,
    });
    expect(schema).toBeNull();
  });
});

describe('ashbySubmitter.buildSubmissionPayload', () => {
  const schema: AtsFormSchema = {
    ats: 'ashby',
    boardToken: 'acme',
    jobId: 'job-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [
      {
        id: '_systemfield_name',
        label: 'Name',
        required: true,
        type: 'String',
      },
      {
        id: '_systemfield_resume',
        label: 'Resume',
        required: false,
        type: 'File',
      },
      { id: 'abc-123', label: 'Why?', required: true, type: 'LongText' },
    ],
  };
  const resume: AtsFilePart = {
    fieldName: 'resume',
    filename: 'resume.pdf',
    contentType: 'application/pdf',
    byteLength: 1024,
    present: true,
  };

  it('maps scalar answers and excludes file questions from fields', () => {
    const payload = ashbySubmitter.buildSubmissionPayload({
      schema,
      answers: { _systemfield_name: 'Ada', 'abc-123': 'Because.' },
      resume,
    });

    expect(payload.endpoint).toBe(
      'https://jobs.ashbyhq.com/acme/job-1/application',
    );
    expect(payload.method).toBe('POST');
    expect(payload.fields).toEqual([
      { name: '_systemfield_name', value: 'Ada' },
      { name: 'abc-123', value: 'Because.' },
    ]);
    expect(payload.files).toEqual([resume]);
  });

  it('emits empty values for unanswered scalar questions (never invents)', () => {
    const payload = ashbySubmitter.buildSubmissionPayload({
      schema,
      answers: { _systemfield_name: 'Ada' },
      resume,
    });
    const why = payload.fields.find((f) => f.name === 'abc-123');
    expect(why?.value).toBe('');
  });
});

describe('ashbySubmitter.submit', () => {
  it('refuses live submission until certified', async () => {
    const payload = ashbySubmitter.buildSubmissionPayload({
      schema: {
        ats: 'ashby',
        boardToken: 'acme',
        jobId: 'job-1',
        fetchedAt: '2026-01-01T00:00:00.000Z',
        questions: [],
      },
      answers: {},
      resume: {
        fieldName: 'resume',
        filename: 'resume.pdf',
        contentType: 'application/pdf',
        byteLength: 0,
        present: false,
      },
    });
    const result = await ashbySubmitter.submit(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('failed');
  });
});

describe('isAshbyFileQuestion', () => {
  it('identifies file questions', () => {
    expect(isAshbyFileQuestion('File')).toBe(true);
    expect(isAshbyFileQuestion('String')).toBe(false);
  });
});
