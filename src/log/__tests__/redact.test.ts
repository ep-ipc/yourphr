/**
 * Log redaction (yourphr#638, yourphr#682), ported from ngdpbase's #1030.
 *
 * The tooth is the RING BUFFER, not stdout. `GET /api/secure/admin/logs` serves `appLog.recent()`
 * to anyone with `admin-read`, so a redactor that only cleaned the console sink would leave the
 * plaintext sitting in memory behind that route and look like it worked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AppLog } from '../index.js';
import { clearRedactedSecrets, redact, redactedSecretCount, refreshRedactedSecrets } from '../redact.js';

/** The minimum ConfigurationManager shape the redactor asks for. */
const configOf = (secretKeys: string[], values: Record<string, string>) => ({
  getStringList: (key: string) => (key === 'yourphr.config.secret-keys' ? secretKeys : []),
  getString: (key: string) => {
    if (!(key in values)) throw new Error(`unknown configuration key: ${key}`);
    return values[key] as string;
  },
});

afterEach(() => clearRedactedSecrets());

describe('log redaction', () => {
  it('is inert before configuration resolves — nothing is read at that point', () => {
    expect(redactedSecretCount()).toBe(0);
    expect(redact('key=s3cret-value-here')).toBe('key=s3cret-value-here');
  });

  it('strikes a configured secret and names the key that held it', () => {
    refreshRedactedSecrets(configOf(['yourphr.database.encryption.key'], {
      'yourphr.database.encryption.key': 'correct-horse-battery-staple',
    }));
    expect(redact('opening db with correct-horse-battery-staple now'))
      .toBe('opening db with [redacted:yourphr.database.encryption.key] now');
  });

  it('keeps the secret out of the RING BUFFER, not just the sink (yourphr#638)', () => {
    const sunk: string[] = [];
    const log = new AppLog(50, (_l, line) => sunk.push(line));
    refreshRedactedSecrets(configOf(['yourphr.backup.encryption.key'], {
      'yourphr.backup.encryption.key': 'travelling-copy-key-9182',
    }));
    log.error('restore failed for travelling-copy-key-9182');

    // The route reads recent(); that copy must be clean.
    expect(log.recent().join('\n')).not.toContain('travelling-copy-key-9182');
    expect(log.recent().join('\n')).toContain('[redacted:yourphr.backup.encryption.key]');
    expect(sunk.join('\n')).not.toContain('travelling-copy-key-9182');
  });

  it('strikes the longer secret first when one contains another', () => {
    refreshRedactedSecrets(configOf(['a', 'b'], { a: 'shared-secret', b: 'shared-secret-extended' }));
    const out = redact('value shared-secret-extended here');
    expect(out).toBe('value [redacted:b] here');
    expect(out).not.toContain('shared-secret');
  });

  it('survives a secret full of regex metacharacters', () => {
    refreshRedactedSecrets(configOf(['k'], { k: 'a.*b[c]+$^(d)|e' }));
    expect(redact('token a.*b[c]+$^(d)|e end')).toBe('token [redacted:k] end');
  });

  it('reports rather than silently skipping, and says why', () => {
    const r = refreshRedactedSecrets(configOf(
      ['tooshort', 'blank', 'ref', 'missing', 'good'],
      { tooshort: 'admin', blank: '   ', ref: '$YOURPHR_UNSET_VAR', good: 'a-long-enough-secret' },
    ));
    expect(r.active).toBe(1);
    expect(Object.fromEntries(r.skipped.map((s) => [s.key, s.reason]))).toEqual({
      tooshort: 'too-short', blank: 'empty', ref: 'env-ref', missing: 'unset',
    });
  });

  it('does not mangle unrelated output for a short secret', () => {
    refreshRedactedSecrets(configOf(['p'], { p: 'admin' }));
    // 'admin' is below the floor: striking it would wreck every line mentioning the admin role.
    expect(redact('admin signed in; admin-read granted')).toBe('admin signed in; admin-read granted');
  });

  it('redacts a value that appears more than once in one line', () => {
    refreshRedactedSecrets(configOf(['k'], { k: 'repeated-secret-value' }));
    expect(redact('repeated-secret-value and repeated-secret-value'))
      .toBe('[redacted:k] and [redacted:k]');
  });

  it('collapses two keys holding the same value to one redaction', () => {
    const r = refreshRedactedSecrets(configOf(['first', 'second'], {
      first: 'identical-secret-value', second: 'identical-secret-value',
    }));
    expect(r.active).toBe(1);
    expect(redact('x identical-secret-value')).toBe('x [redacted:first]');
  });

  it('rebuilds wholesale rather than accumulating', () => {
    refreshRedactedSecrets(configOf(['a'], { a: 'first-secret-value' }));
    refreshRedactedSecrets(configOf(['b'], { b: 'second-secret-value' }));
    expect(redactedSecretCount()).toBe(1);
    expect(redact('first-secret-value')).toBe('first-secret-value'); // no longer configured
    expect(redact('second-secret-value')).toBe('[redacted:b]');
  });

  it('treats a stale secret-keys entry as a skip, not a crash', () => {
    const r = refreshRedactedSecrets(configOf(['yourphr.key.that.was.removed'], {}));
    expect(r.active).toBe(0);
    expect(r.skipped[0]?.reason).toBe('unset');
  });
});
