import { describe, expect, it } from 'vitest';
import {
  opportunityLabel,
  postedCompensation,
  postedDate,
  postingLink,
} from './public-opportunity-presentation.js';

const pay = {
  currency: 'USD',
  min: 174200,
  max: 261200,
  period: 'year',
  equity: null,
  source: 'posted' as const,
};
describe('public listing details', () => {
  it('formats posted pay ranges with explicit currency and period', () => {
    expect(postedCompensation(pay)).toBe('USD 174,200–261,200 / year');
    expect(
      postedCompensation({ ...pay, min: 25.5, max: 25.5, period: 'hour' }),
    ).toBe('USD 25.5 / hour');
    expect(postedCompensation({ ...pay, min: null })).toBe(
      'USD Up to 261,200 / year',
    );
    expect(postedCompensation({ ...pay, max: null })).toBe(
      'USD From 174,200 / year',
    );
    expect(postedCompensation({ ...pay, min: 0, max: 0 })).toBe('USD 0 / year');
  });
  it('does not invent compensation or show malformed ranges', () => {
    expect(postedCompensation(null)).toBe('');
    expect(postedCompensation({ ...pay, min: null, max: null })).toBe('');
    expect(postedCompensation({ ...pay, currency: '' })).toBe('');
    expect(postedCompensation({ ...pay, min: 300000 })).toBe('');
    expect(postedCompensation({ ...pay, source: 'estimated' } as never)).toBe(
      '',
    );
  });
  it('uses readable labels and deterministic dates, hiding unknown values', () => {
    expect(opportunityLabel('full_time')).toBe('Full time');
    expect(opportunityLabel('unknown')).toBe('');
    expect(postedDate(null)).toBe('');
    expect(postedDate('invalid')).toBe('');
    expect(postedDate('2026-10-07T23:00:00Z')).toBe('Oct 7, 2026');
  });
  it('only permits HTTP posting URLs without embedded credentials', () => {
    expect(postingLink('https://www.example.com/jobs/123')).toEqual({
      href: 'https://www.example.com/jobs/123',
      host: 'example.com',
    });
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,bad',
      '/relative',
      'https://user:password@example.com',
    ])
      expect(postingLink(value)).toBeNull();
  });
});
