import { describe, expect, it, vi } from 'vitest';
import { createRootSource, parseRootSourceSetup } from './source-root-setup.js';

function form(values: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe('root source setup', () => {
  it('normalizes a friendly OpenAI Ashby source into an explicit root', async () => {
    const input = parseRootSourceSetup(
      form({
        active: 'on',
        name: 'OpenAI Careers',
        provider: 'ashby',
        type: 'company_careers',
        url: 'https://jobs.ashbyhq.com/openai#openings',
      }),
    );
    const save = vi.fn(async () => undefined);
    const create = vi.fn(async (payload: Record<string, unknown>) => ({
      ...payload,
      id: 'source-1',
      save,
    }));

    await expect(
      createRootSource(input, { sourceCollection: { create } }),
    ).resolves.toEqual({ id: 'source-1' });

    expect(create).toHaveBeenCalledWith({
      isActive: true,
      name: 'OpenAI Careers',
      parentSourceId: null,
      provider: 'ashby',
      refreshCadence: 'ad_hoc',
      sourceRole: 'root',
      type: 'company_careers',
      url: 'https://jobs.ashbyhq.com/openai',
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    [
      {
        name: 'OpenAI Careers',
        provider: 'not-a-provider',
        url: 'https://jobs.ashbyhq.com/openai',
      },
      'supported provider',
    ],
    [
      {
        name: 'OpenAI Careers',
        provider: 'ashby',
        url: 'http://jobs.ashbyhq.com/openai',
      },
      'public HTTPS root URL',
    ],
    [
      {
        name: 'OpenAI Careers',
        provider: 'ashby',
        url: 'https://user:secret@jobs.ashbyhq.com/openai',
      },
      'public HTTPS root URL',
    ],
    [
      {
        name: 'OpenAI Careers',
        provider: 'ashby',
        url: 'https://localhost/openai',
      },
      'public HTTPS root URL',
    ],
  ])('rejects invalid setup input %#', (values, message) => {
    expect(() => parseRootSourceSetup(form(values))).toThrow(message);
  });
});
