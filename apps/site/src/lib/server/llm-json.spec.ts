import { describe, expect, it } from 'vitest';
import {
  LlmJsonParseError,
  requireJsonObjectFromText,
  tryParseJsonObjectFromText,
} from './llm-json';

describe('llm JSON parsing', () => {
  it('extracts JSON objects from fenced model output', () => {
    expect(
      tryParseJsonObjectFromText(
        [
          '```json',
          '{"descriptionSummary":"Build agent workflows","requiredSkills":["TypeScript"]}',
          '```',
        ].join('\n'),
      ),
    ).toEqual({
      descriptionSummary: 'Build agent workflows',
      requiredSkills: ['TypeScript'],
    });
  });

  it('keeps braces inside strings while finding the first balanced object', () => {
    expect(
      tryParseJsonObjectFromText(
        [
          'Here is the extracted JSON:',
          '{"descriptionSummary":"Build {agent} workflow systems.","requiredSkills":["TypeScript"]}',
          'I also considered {"ignored":true}.',
        ].join('\n'),
      ),
    ).toEqual({
      descriptionSummary: 'Build {agent} workflow systems.',
      requiredSkills: ['TypeScript'],
    });
  });

  it('throws diagnostics for malformed model output', () => {
    expect(() =>
      requireJsonObjectFromText('not json', 'LLM extraction'),
    ).toThrow(LlmJsonParseError);

    try {
      requireJsonObjectFromText('not json', 'LLM extraction');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmJsonParseError);
      expect((error as LlmJsonParseError).diagnostics).toEqual({
        rawContentLength: 'not json'.length,
        rawContentPreview: 'not json',
        rawContentTruncated: false,
      });
    }
  });
});
