/**
 * The human-readable text of a record (yourphr#599), and the entity-unescaping order that
 * yourphr#681 got wrong.
 *
 * The tooth here is the double-unescape: `&amp;` used to be resolved FIRST, so the pass fed its own
 * output back to itself and turned deliberately-escaped markup into live markup. These records are
 * documents other people wrote, so "the input contains an escaped tag" is an ordinary case rather
 * than an attack, and the function must not decide it meant something else.
 */
import { describe, expect, it } from 'vitest';
import { textFor } from '../record-text.js';

const narrative = (div: string): Record<string, unknown> => ({
  resourceType: 'Condition',
  id: 'c-1',
  text: { status: 'generated', div },
});

describe('record text: narrative entities', () => {
  it('does not manufacture markup from an escaped tag — the yourphr#681 regression', () => {
    // Written by whoever produced the document: the literal characters "<script>", escaped once
    // for the narrative, and escaped AGAIN because they are being shown as an example.
    const text = textFor(narrative('<div>see &amp;lt;script&amp;gt; below</div>'));
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
  });

  it('leaves no angle bracket that the input did not already contain unescaped', () => {
    const text = textFor(narrative('<p>&amp;lt;img src=x onerror=alert(1)&amp;gt;</p>'));
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('still unescapes ordinary entities once', () => {
    const text = textFor(narrative('<p>Fever &gt; 38&#176;C &amp; chills</p>'));
    expect(text).toContain('>');
    expect(text).toContain('&');
    // The ampersand is resolved last, so the text reads as written rather than as re-parsed.
    expect(text).toContain('38&#176;C');
  });

  it('resolves an ampersand that is genuinely escaped', () => {
    expect(textFor(narrative('<p>Smith &amp; Nephew</p>'))).toContain('Smith & Nephew');
  });

  it('strips tags to whitespace rather than concatenating words across them', () => {
    const text = textFor(narrative('<p>Metformin</p><p>500 MG</p>'));
    expect(text).toContain('Metformin');
    expect(text).toContain('500 MG');
    expect(text).not.toContain('Metformin500');
  });

  it('handles quotes and apostrophes without leaving a bare entity', () => {
    const text = textFor(narrative('<p>&quot;stable&quot; per patient&#39;s report</p>'));
    expect(text).toContain('"stable"');
    expect(text).toContain("patient's");
  });
});
