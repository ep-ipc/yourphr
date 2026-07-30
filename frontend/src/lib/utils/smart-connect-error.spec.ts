import {
  extractSmartConnectErrorCode,
  formatSmartConnectFailure,
  isRetryableSmartConnectError,
} from './smart-connect-error';

function httpErr(body: {error?: string; error_code?: string}, status = 502): any {
  return {
    name: 'HttpErrorResponse',
    status,
    error: body,
  };
}

describe('smart-connect-error', () => {
  it('extracts error_code from HttpErrorResponse body', () => {
    expect(extractSmartConnectErrorCode(httpErr({error_code: 'relay_poll_timeout'}))).toBe(
      'relay_poll_timeout'
    );
    expect(extractSmartConnectErrorCode({})).toBeUndefined();
  });

  it('retries only relay_poll_timeout', () => {
    expect(isRetryableSmartConnectError(httpErr({error_code: 'relay_poll_timeout', error: 'timed out'}))).toBe(
      true
    );
    expect(isRetryableSmartConnectError(httpErr({error_code: 'relay_unauthorized', error: 'secret'}))).toBe(
      false
    );
    expect(isRetryableSmartConnectError(httpErr({error_code: 'relay_not_configured', error: 'no secret'}))).toBe(
      false
    );
  });

  it('does not retry unauthorized even when message mentions authorization code from relay', () => {
    // Regression: old regex /authorization code from relay|timed out/ retried secret mismatches.
    const err = httpErr({
      error:
        'could not retrieve authorization code from relay: relay: unauthorized — the shared secret does not match',
    });
    expect(isRetryableSmartConnectError(err)).toBe(false);
  });

  it('retries legacy timeout messages without error_code', () => {
    const err = httpErr({
      error: 'could not retrieve authorization code from relay: relay: timed out waiting for authorization code',
    });
    expect(isRetryableSmartConnectError(err)).toBe(true);
  });

  it('formatSmartConnectFailure uses distinct copy for known codes', () => {
    const timeout = formatSmartConnectFailure(
      httpErr({error_code: 'relay_poll_timeout', error: 'timed out'})
    );
    expect(timeout.toLowerCase()).toContain('connected');
    expect(timeout.toLowerCase()).toContain('60');

    const unauth = formatSmartConnectFailure(
      httpErr({error_code: 'relay_unauthorized', error: 'secret'})
    );
    expect(unauth.toLowerCase()).toContain('secret');

    const noconf = formatSmartConnectFailure(
      httpErr({error_code: 'relay_not_configured', error: 'missing'})
    );
    expect(noconf.toLowerCase()).toContain('relay.secret');
  });
});
