import { highlightFormula } from '../highlight';

describe('highlightFormula', () => {
  it('covers every character of the source in order', () => {
    const source = 'if(prop("Done") and not empty(prop("Due")), "✓ " + format(1.5), "") /* note */';
    const segments = highlightFormula(source);

    expect(segments.map((segment) => segment.text).join('')).toBe(source);
  });

  it('falls back to plain text while the source cannot be tokenized', () => {
    expect(highlightFormula('"unterminated')).toEqual([{ text: '"unterminated', kind: 'plain' }]);
    expect(highlightFormula('')).toEqual([]);
  });
});
