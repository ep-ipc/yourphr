import {extractErrorFromResponse} from './error_extract';

/** Backend error_code values from handler/smart_relay_poll.go (#406). */
export type SmartConnectErrorCode =
  | 'relay_not_configured'
  | 'relay_unauthorized'
  | 'relay_poll_timeout'
  | 'relay_poll_failed'
  | string;

export function extractSmartConnectErrorCode(err: any): string | undefined {
  const code = err?.error?.error_code;
  return typeof code === 'string' && code.length ? code : undefined;
}

/**
 * Only true poll timeouts are safe to retry across the login window.
 * Misconfiguration (secret / not configured) must not spin for minutes (#406).
 */
export function isRetryableSmartConnectError(err: any): boolean {
  const code = extractSmartConnectErrorCode(err);
  if (code === 'relay_poll_timeout') {
    return true;
  }
  if (code) {
    return false;
  }
  // Older backends without error_code: only pure timeout wording, not unauthorized/not configured.
  const msg = extractErrorFromResponse(err) || '';
  if (/unauthorized|not configured|rejected the shared secret/i.test(msg)) {
    return false;
  }
  return /timed out waiting for the authorization code|timed out waiting for authorization code/i.test(msg);
}

/** Patient/admin-facing message after the connect loop gives up (or hits a terminal error). */
export function formatSmartConnectFailure(err: any): string {
  const code = extractSmartConnectErrorCode(err);
  const raw = extractErrorFromResponse(err) || 'Unknown Error';

  switch (code) {
    case 'relay_poll_timeout':
      return (
        'Timed out waiting for you to finish signing in. ' +
        'If the popup already said "Connected", click Connect again and complete login promptly — ' +
        'the authorization code only lasts about 60 seconds. ' +
        'Also confirm the provider redirect URI matches this server\'s relay callback (Admin → relay card).'
      );
    case 'relay_unauthorized':
      return (
        'The OAuth relay rejected this server\'s shared secret. ' +
        'Set the same YOURPHR_RELAY_SECRET on the YourPHR app and on the relay service.'
      );
    case 'relay_not_configured':
      return (
        'This server has no OAuth relay secret configured (YOURPHR_RELAY_SECRET / relay.secret), ' +
        'so live provider connect cannot complete. See Admin → relay card.'
      );
    case 'relay_poll_failed':
      return 'Could not get the authorization code from the relay: ' + raw;
    default:
      break;
  }

  if (/token exchange failed/i.test(raw)) {
    return (
      'Token exchange failed after sign-in. Often a redirect_uri mismatch — ' +
      'register the exact callback URL from Admin → relay with the provider. Detail: ' + raw
    );
  }
  if (/unauthorized|shared secret/i.test(raw)) {
    return (
      'The OAuth relay rejected this server\'s shared secret. ' +
      'Set the same YOURPHR_RELAY_SECRET on the YourPHR app and on the relay. Detail: ' + raw
    );
  }
  if (/not configured/i.test(raw)) {
    return (
      'OAuth relay is not configured on this server (YOURPHR_RELAY_SECRET). ' +
      'See Admin → relay card. Detail: ' + raw
    );
  }
  if (/timed out/i.test(raw) && /authorization code|relay/i.test(raw)) {
    return (
      'Timed out waiting for you to finish signing in. ' +
      'If the popup already said "Connected", click Connect again promptly. Detail: ' + raw
    );
  }

  return 'Connection failed: ' + raw;
}
