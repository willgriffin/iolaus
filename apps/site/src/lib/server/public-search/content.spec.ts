import { describe, expect, it } from 'vitest';
import { sanitizePublicOpportunityText } from './content.js';

describe('sanitizePublicOpportunityText', () => {
  it('returns bounded readable posting text without active markup or contact data', () => {
    expect(
      sanitizePublicOpportunityText(
        '<p>Build systems.</p><script>PRIVATE_SCRIPT()</script><style>.x{}</style>Email jobs@example.com or +1 (403) 555-0100.</p>',
        100,
      ),
    ).toBe('Build systems.\nEmail [contact removed] or [contact removed].');
    expect(
      sanitizePublicOpportunityText(
        'Visible &lt;script&gt;PRIVATE_SCRIPT()&lt;/script&gt; text.',
        100,
      ),
    ).toBe('Visible text.');
    expect(
      sanitizePublicOpportunityText('Visible <script>PRIVATE_SCRIPT()', 100),
    ).toBe('Visible');
    expect(sanitizePublicOpportunityText('Bad &#999999999; entity.', 100)).toBe(
      'Bad � entity.',
    );
  });

  it('omits non-text values and bounds text after normalization', () => {
    expect(sanitizePublicOpportunityText({ text: 'nope' }, 20)).toBeUndefined();
    expect(sanitizePublicOpportunityText('abcdefghijklmnop', 8)).toBe(
      'abcdefgh',
    );
  });
});
