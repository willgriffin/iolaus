import { describe, expect, it, vi } from 'vitest';
import {
  extractLeverQuestions,
  isLeverFileQuestion,
  leverSubmitter,
  parseLeverUrl,
} from './lever.js';
import type { AtsFilePart, AtsFormSchema } from './types.js';

// A trimmed Lever apply page. Mirrors the real markup: one
// `<li class="application-question …">` per field, a `.application-label`
// (with a `<span class="required">✱</span>` marker on required fields), and the
// wire field `name`. The checkbox block nests its own `<li class="column">`s —
// the parser must NOT split on those.
function applyHtml(): string {
  return `<!doctype html><form class="application-form">
    <li class="application-question resume"><label><div class="application-label">Resume/CV <span class="required">✱</span></div><div class="application-field"><input type="file" name="resume" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input type="text" name="name" required></div></label></li>
    <li class="application-question"><label><div class="application-label">Email<span class="required">✱</span></div><div class="application-field"><input type="text" name="email" required></div></label></li>
    <li class="application-question"><div class="application-label multiple-select">Pronouns</div><div class="application-field"><ul><li class="column"><label><input type="checkbox" name="pronouns" value="He/him"><span>He/him</span></label></li><li class="column"><label><input type="checkbox" name="pronouns" value="She/her"><span>She/her</span></label></li></ul></div></li>
    <li class="application-question"><div class="application-label">What is your age range? <span class="required">✱</span></div><div class="application-field"><input type="text" name="surveysResponses[8dfb][responses][field0]" required></div></li>
    <button class="posting-btn-submit">Submit</button>
  </form>`;
}

function htmlResponse(body: string, ok = true): Response {
  return {
    ok,
    text: async () => body,
  } as unknown as Response;
}

describe('parseLeverUrl', () => {
  it('parses the canonical hosted URL', () => {
    expect(parseLeverUrl('https://jobs.lever.co/acme/uuid-1')).toEqual({
      boardToken: 'acme',
      jobId: 'uuid-1',
    });
  });

  it('ignores an /apply suffix and query string', () => {
    expect(
      parseLeverUrl('https://jobs.lever.co/acme/uuid-1/apply?source=x'),
    ).toEqual({ boardToken: 'acme', jobId: 'uuid-1' });
  });

  it('rejects lookalike hosts', () => {
    expect(parseLeverUrl('https://jobs.lever.co.evil.com/acme/1')).toBeNull();
    expect(parseLeverUrl('https://jobs.notlever.co/acme/1')).toBeNull();
  });

  it('returns null when the job id is missing', () => {
    expect(parseLeverUrl('https://jobs.lever.co/acme')).toBeNull();
  });

  it('returns null for malformed urls', () => {
    expect(parseLeverUrl('not a url')).toBeNull();
  });
});

describe('leverSubmitter.supports', () => {
  it('matches lever case-insensitively and nothing else', () => {
    expect(leverSubmitter.supports('lever')).toBe(true);
    expect(leverSubmitter.supports('Lever')).toBe(true);
    expect(leverSubmitter.supports('greenhouse')).toBe(false);
    expect(leverSubmitter.supports('')).toBe(false);
  });
});

describe('leverSubmitter.matchesUrl', () => {
  const schema: AtsFormSchema = {
    ats: 'lever',
    boardToken: 'acme',
    jobId: 'uuid-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [],
  };

  it('matches when board slug and job id agree with the URL', () => {
    expect(
      leverSubmitter.matchesUrl(schema, 'https://jobs.lever.co/acme/uuid-1'),
    ).toBe(true);
  });

  it('rejects a different job id (stale schema)', () => {
    expect(
      leverSubmitter.matchesUrl(schema, 'https://jobs.lever.co/acme/uuid-9'),
    ).toBe(false);
  });

  it('rejects a different board slug', () => {
    expect(
      leverSubmitter.matchesUrl(schema, 'https://jobs.lever.co/other/uuid-1'),
    ).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(leverSubmitter.matchesUrl(schema, 'not a url')).toBe(false);
  });
});

describe('extractLeverQuestions', () => {
  it('reads one field per application-question block, incl. nested checkbox blocks', () => {
    expect(extractLeverQuestions(applyHtml())).toEqual([
      { id: 'resume', label: 'Resume/CV', required: true, type: 'resume' },
      { id: 'name', label: 'Full name', required: true, type: 'text' },
      { id: 'email', label: 'Email', required: true, type: 'text' },
      // Nested <li class="column"> must not create extra questions.
      { id: 'pronouns', label: 'Pronouns', required: false, type: 'text' },
      {
        id: 'surveysResponses[8dfb][responses][field0]',
        label: 'What is your age range?',
        required: true,
        type: 'text',
      },
    ]);
  });

  it('returns null when there are no question blocks', () => {
    expect(extractLeverQuestions('<html>no form</html>')).toBeNull();
    expect(extractLeverQuestions(undefined)).toBeNull();
    expect(extractLeverQuestions('')).toBeNull();
  });
});

describe('leverSubmitter.fetchFormSchema', () => {
  it('fetches the apply page and maps the question blocks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(applyHtml()));

    const schema = await leverSubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.lever.co/acme/uuid-1',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Normalizes to the canonical apply page.
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://jobs.lever.co/acme/uuid-1/apply',
    );
    expect(schema?.ats).toBe('lever');
    expect(schema?.boardToken).toBe('acme');
    expect(schema?.jobId).toBe('uuid-1');
    expect(schema?.questions.map((q) => q.id)).toEqual([
      'resume',
      'name',
      'email',
      'pronouns',
      'surveysResponses[8dfb][responses][field0]',
    ]);
  });

  it('returns null when the URL is not lever', async () => {
    const fetchImpl = vi.fn();
    const schema = await leverSubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.ashbyhq.com/acme/1',
      fetchImpl,
    });
    expect(schema).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('forbidden', false));
    const schema = await leverSubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.lever.co/acme/uuid-1',
      fetchImpl,
    });
    expect(schema).toBeNull();
  });

  it('returns null when the apply page has no question blocks', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(htmlResponse('<html>no form</html>'));
    const schema = await leverSubmitter.fetchFormSchema({
      applyUrl: 'https://jobs.lever.co/acme/uuid-1',
      fetchImpl,
    });
    expect(schema).toBeNull();
  });
});

describe('leverSubmitter.buildSubmissionPayload', () => {
  const schema: AtsFormSchema = {
    ats: 'lever',
    boardToken: 'acme',
    jobId: 'uuid-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    questions: [
      { id: 'resume', label: 'Resume/CV', required: true, type: 'resume' },
      { id: 'name', label: 'Full name', required: true, type: 'text' },
      {
        id: 'surveysResponses[8dfb][responses][field0]',
        label: 'Why?',
        required: true,
        type: 'text',
      },
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
    const payload = leverSubmitter.buildSubmissionPayload({
      schema,
      answers: {
        name: 'Ada',
        'surveysResponses[8dfb][responses][field0]': 'Because.',
      },
      resume,
    });

    expect(payload.endpoint).toBe('https://jobs.lever.co/acme/uuid-1/apply');
    expect(payload.method).toBe('POST');
    expect(payload.fields).toEqual([
      { name: 'name', value: 'Ada' },
      { name: 'surveysResponses[8dfb][responses][field0]', value: 'Because.' },
    ]);
    expect(payload.files).toEqual([resume]);
  });

  it('emits empty values for unanswered scalar questions (never invents)', () => {
    const payload = leverSubmitter.buildSubmissionPayload({
      schema,
      answers: { name: 'Ada' },
      resume,
    });
    const survey = payload.fields.find(
      (f) => f.name === 'surveysResponses[8dfb][responses][field0]',
    );
    expect(survey?.value).toBe('');
  });
});

describe('leverSubmitter.submit', () => {
  it('refuses live submission until certified', async () => {
    const payload = leverSubmitter.buildSubmissionPayload({
      schema: {
        ats: 'lever',
        boardToken: 'acme',
        jobId: 'uuid-1',
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
    const result = await leverSubmitter.submit(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('failed');
  });
});

describe('isLeverFileQuestion', () => {
  it('identifies file questions', () => {
    expect(isLeverFileQuestion('resume')).toBe(true);
    expect(isLeverFileQuestion('text')).toBe(false);
  });
});
