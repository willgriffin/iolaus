import { describe, expect, it, vi } from 'vitest';
import {
  greenhouseSubmitter,
  isGreenhouseFileQuestion,
  parseGreenhouseUrl,
} from './greenhouse.js';
import type { AtsFilePart, AtsFormSchema } from './types.js';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('parseGreenhouseUrl', () => {
  it('parses the hosted board form', () => {
    expect(
      parseGreenhouseUrl('https://boards.greenhouse.io/acme/jobs/4567'),
    ).toEqual({ boardToken: 'acme', jobId: '4567' });
  });

  it('parses the job-boards host', () => {
    expect(
      parseGreenhouseUrl('https://job-boards.greenhouse.io/acme/jobs/999'),
    ).toEqual({ boardToken: 'acme', jobId: '999' });
  });

  it('parses the embedded form query params', () => {
    expect(
      parseGreenhouseUrl(
        'https://boards.greenhouse.io/embed/job_app?for=acme&token=321',
      ),
    ).toEqual({ boardToken: 'acme', jobId: '321' });
  });

  it('parses the hosted board gh_jid query form', () => {
    expect(
      parseGreenhouseUrl('https://boards.greenhouse.io/acme?gh_jid=654'),
    ).toEqual({ boardToken: 'acme', jobId: '654' });
  });

  it('returns null for non-greenhouse hosts', () => {
    expect(parseGreenhouseUrl('https://jobs.lever.co/acme/123')).toBeNull();
  });

  it('rejects lookalike hosts', () => {
    expect(
      parseGreenhouseUrl('https://boards.evilgreenhouse.io/acme/jobs/1'),
    ).toBeNull();
  });

  it('returns null when the job id cannot be resolved', () => {
    expect(parseGreenhouseUrl('https://boards.greenhouse.io/acme')).toBeNull();
  });

  it('does not invent a board token from malformed hosted paths', () => {
    expect(
      parseGreenhouseUrl('https://boards.greenhouse.io/jobs/123'),
    ).toBeNull();
    expect(
      parseGreenhouseUrl(
        'https://boards.greenhouse.io/embed/job_app?gh_jid=123',
      ),
    ).toBeNull();
  });

  it('returns null for malformed urls', () => {
    expect(parseGreenhouseUrl('not a url')).toBeNull();
  });
});

describe('greenhouseSubmitter.supports', () => {
  it('matches greenhouse case-insensitively and nothing else', () => {
    expect(greenhouseSubmitter.supports('greenhouse')).toBe(true);
    expect(greenhouseSubmitter.supports('Greenhouse')).toBe(true);
    expect(greenhouseSubmitter.supports('ashby')).toBe(false);
    expect(greenhouseSubmitter.supports('')).toBe(false);
  });
});

describe('greenhouseSubmitter.matchesUrl', () => {
  const schema: AtsFormSchema = {
    ats: 'greenhouse',
    boardToken: 'acme',
    jobId: '4567',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [],
  };

  it('matches when board token and job id agree with the URL', () => {
    expect(
      greenhouseSubmitter.matchesUrl(
        schema,
        'https://boards.greenhouse.io/acme/jobs/4567',
      ),
    ).toBe(true);
  });

  it('rejects a different job id (stale schema)', () => {
    expect(
      greenhouseSubmitter.matchesUrl(
        schema,
        'https://boards.greenhouse.io/acme/jobs/9999',
      ),
    ).toBe(false);
  });

  it('rejects a different board token', () => {
    expect(
      greenhouseSubmitter.matchesUrl(
        schema,
        'https://boards.greenhouse.io/other/jobs/4567',
      ),
    ).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(greenhouseSubmitter.matchesUrl(schema, 'not a url')).toBe(false);
  });
});

describe('greenhouseSubmitter.fetchFormSchema', () => {
  it('flattens questions and fields into the schema', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        questions: [
          {
            label: 'First Name',
            required: true,
            fields: [{ name: 'first_name', type: 'input_text' }],
          },
          {
            label: 'Resume',
            required: true,
            fields: [{ name: 'resume', type: 'input_file' }],
          },
          {
            label: 'Cover Letter',
            required: false,
            fields: [{ name: 'cover_letter_text', type: 'textarea' }],
          },
        ],
      }),
    );

    const schema = await greenhouseSubmitter.fetchFormSchema({
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/4567',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4567?questions=true',
    );
    expect(schema?.ats).toBe('greenhouse');
    expect(schema?.boardToken).toBe('acme');
    expect(schema?.jobId).toBe('4567');
    expect(schema?.questions).toEqual([
      {
        id: 'first_name',
        label: 'First Name',
        required: true,
        type: 'input_text',
      },
      { id: 'resume', label: 'Resume', required: true, type: 'input_file' },
      {
        id: 'cover_letter_text',
        label: 'Cover Letter',
        required: false,
        type: 'textarea',
      },
    ]);
  });

  it('returns null when the URL is not greenhouse', async () => {
    const fetchImpl = vi.fn();
    const schema = await greenhouseSubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.lever.co/acme/1',
      fetchImpl,
    });
    expect(schema).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));
    const schema = await greenhouseSubmitter.fetchFormSchema({
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/4567',
      fetchImpl,
    });
    expect(schema).toBeNull();
  });
});

describe('greenhouseSubmitter.buildSubmissionPayload', () => {
  const schema: AtsFormSchema = {
    ats: 'greenhouse',
    boardToken: 'acme',
    jobId: '4567',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [
      {
        id: 'first_name',
        label: 'First Name',
        required: true,
        type: 'input_text',
      },
      { id: 'resume', label: 'Resume', required: true, type: 'input_file' },
      { id: 'question_7', label: 'Why?', required: true, type: 'textarea' },
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
    const payload = greenhouseSubmitter.buildSubmissionPayload({
      schema,
      answers: { first_name: 'Ada', question_7: 'Because.' },
      resume,
    });

    expect(payload.endpoint).toBe(
      'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4567',
    );
    expect(payload.method).toBe('POST');
    expect(payload.fields).toEqual([
      { name: 'first_name', value: 'Ada' },
      { name: 'question_7', value: 'Because.' },
    ]);
    expect(payload.files).toEqual([resume]);
  });

  it('emits empty values for unanswered scalar questions (never invents)', () => {
    const payload = greenhouseSubmitter.buildSubmissionPayload({
      schema,
      answers: { first_name: 'Ada' },
      resume,
    });
    const question7 = payload.fields.find((f) => f.name === 'question_7');
    expect(question7?.value).toBe('');
  });
});

describe('greenhouseSubmitter.submit', () => {
  it('refuses live submission until certified', async () => {
    const payload = greenhouseSubmitter.buildSubmissionPayload({
      schema: {
        ats: 'greenhouse',
        boardToken: 'acme',
        jobId: '1',
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
    const result = await greenhouseSubmitter.submit(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('failed');
  });
});

describe('isGreenhouseFileQuestion', () => {
  it('identifies file questions', () => {
    expect(isGreenhouseFileQuestion('input_file')).toBe(true);
    expect(isGreenhouseFileQuestion('input_text')).toBe(false);
  });
});
