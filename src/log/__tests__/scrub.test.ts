/**
 * The harness reporter's credential scrub (yourphr#682).
 *
 * Lives beside the app's redaction tests on purpose: the two are the same idea with different
 * sources of truth — configuration for the app, shape for a harness that has no configuration —
 * and reading them together is what stops the weaker one being mistaken for the stronger.
 *
 * The second half of this file is the more important half: proof it does NOT eat the identifiers
 * the harnesses assert on. A reporter that corrupts its own evidence is worse than one that prints
 * too much.
 */
import { describe, expect, it } from 'vitest';
import { scrub } from '../../../scripts/lib/scrub.js';

describe('harness credential scrub', () => {
  it('strikes a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLWhlcmU';
    expect(scrub(`signed in with ${jwt} ok`)).toBe('signed in with [redacted:jwt] ok');
  });

  it('strikes a bearer header echo', () => {
    expect(scrub('authorization: Bearer abcdef0123456789xyz'))
      .toBe('authorization: [redacted:bearer]');
  });

  it('strikes the session cookie by name, and stops at the delimiter', () => {
    expect(scrub('set-cookie: yourphr_session=abc123def456; Path=/; HttpOnly'))
      .toBe('set-cookie: [redacted:session-cookie]; Path=/; HttpOnly');
  });

  it('strikes named credential fields in an interpolated body', () => {
    const body = '{"username":"alice","password":"correct-horse","code_verifier":"xyz"}';
    const out = scrub(body);
    expect(out).not.toContain('correct-horse');
    expect(out).not.toContain('xyz');
    expect(out).toContain('"username":"alice"'); // the non-secret survives
  });

  // --- what it must NOT touch -------------------------------------------------------------------

  it('leaves status codes alone — the line CodeQL actually flagged', () => {
    expect(scrub('demo 403, alice 200')).toBe('demo 403, alice 200');
  });

  it('leaves FHIR ids and resource references intact', () => {
    const s = 'Condition/c-1 MedicationRequest/synthetic-3ffd6f9f source-4d2a1b';
    expect(scrub(s)).toBe(s);
  });

  it('leaves a hex digest alone — harnesses assert on these', () => {
    const s = 'digest 6bc65cb5aee99f0a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899';
    expect(scrub(s)).toBe(s);
  });

  it('leaves an ordinary sentence with the word token in it alone', () => {
    expect(scrub('the source has no refresh token and will ask to reconnect'))
      .toBe('the source has no refresh token and will ask to reconnect');
  });

  it('is a no-op on empty and non-string input', () => {
    expect(scrub('')).toBe('');
    expect(scrub(undefined as unknown as string)).toBe(undefined as unknown as string);
  });
});
