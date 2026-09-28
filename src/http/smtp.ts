/**
 * A capability to hand mail to ONE operator-configured SMTP relay (yourphr#536).
 *
 * It lives in src/http for the reason internal-service.ts does: this directory is the network's
 * single door (scripts/check-http-boundary.sh), and a new way out of the process belongs where the
 * others are, so they are reviewed together. SMTP is not HTTP, but it is egress all the same.
 *
 * Why not the guarded client. The guard refuses internal addresses, and a relay is often exactly
 * that — a Postfix on the same LAN. So, as with the converter, the widening is made as narrow as
 * the need:
 *
 *   - Bound to one host and port at construction, taken from configuration an admin set. Nothing
 *     that arrives in a request can choose where mail goes; a caller supplies only the message.
 *   - Always encrypted. `secure` (port 465) is TLS from the first byte; otherwise STARTTLS is
 *     REQUIRED, so a relay that does not offer it gets nothing — not even the password. The mail can
 *     carry medical information, and sending it over a connection nobody checked is worse than not
 *     sending it.
 *   - Certificates are verified, always. There is no option to accept an unverified one. `ca` exists
 *     for a relay whose certificate is signed by the operator's own authority, and for tests; it adds
 *     a trust anchor, it does not remove the check.
 *   - Timeouts on connect, greeting and socket, so a relay that never answers cannot hold a caller.
 *
 * Errors come back as SmtpError with a sentence naming what to fix, because the operator reads them
 * on the Admin screen (yourphr#527 is what the silent version looks like).
 */
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';

export interface SmtpRelayConfig {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). False means STARTTLS, which is then required. */
  secure: boolean;
  user?: string;
  pass?: string;
  /** Extra trust anchor(s), PEM. Never a way to skip verification. */
  ca?: string | string[];
  /** Milliseconds for connect, greeting and each socket wait. */
  timeoutMs?: number;
}

export interface SmtpMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** A send that did not happen, with the cause in words an operator can act on. */
export class SmtpError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class SmtpRelay {
  constructor(private readonly config: SmtpRelayConfig) {
    if (!config.host.trim()) throw new SmtpError('No SMTP relay is configured (yourphr.mail.provider.smtp.host is empty).', 'NOHOST');
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new SmtpError(`The SMTP port ${String(config.port)} is not a port number (yourphr.mail.provider.smtp.port).`, 'BADPORT');
    }
  }

  /** Where this relay sends, for the log and the Admin screen. Never includes the credentials. */
  get destination(): string {
    return `${this.config.host}:${this.config.port} (${this.config.secure ? 'TLS' : 'STARTTLS required'})`;
  }

  async send(message: SmtpMessage): Promise<void> {
    const timeout = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      requireTLS: !this.config.secure,
      ...(this.config.user ? { auth: { user: this.config.user, pass: this.config.pass ?? '' } } : {}),
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(isIP(this.config.host) ? {} : { servername: this.config.host }), ...(this.config.ca ? { ca: this.config.ca } : {}) },
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
    try {
      await transport.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
    } catch (err) {
      throw explain(err as Error & { code?: string; responseCode?: number; response?: string }, this.config);
    } finally {
      transport.close();
    }
  }
}

/** nodemailer's error, as a sentence that names the fix. The password never appears in one. */
function explain(err: Error & { code?: string; responseCode?: number; response?: string }, config: SmtpRelayConfig): SmtpError {
  const where = `${config.host}:${config.port}`;
  const said = err.response ? ` The relay said: ${err.response.trim()}` : '';
  const certificate = /certificate|self[- ]signed|unable to verify|CERT_|altnames/i.test(err.message);
  if (certificate) return new SmtpError(`The relay at ${where} presented a certificate that could not be verified (${err.message}). Mail is not sent over an unverified connection.`, 'CERT');
  switch (err.code) {
    case 'EAUTH':
      return new SmtpError(`The relay at ${where} refused the username or password (yourphr.mail.provider.smtp.user / .pass).${said}`, 'EAUTH');
    case 'ETLS':
      return new SmtpError(`The relay at ${where} did not offer an encrypted connection (STARTTLS), so nothing was sent. Use a relay that supports it, or port 465 with secure on.${said}`, 'ETLS');
    case 'EENVELOPE':
      return new SmtpError(`The relay at ${where} refused the sender or recipient address — check yourphr.mail.from and the address you sent to.${said}`, 'EENVELOPE');
    case 'ETIMEDOUT':
      return new SmtpError(`The relay at ${where} did not answer in time. Check the host and port, and that this instance can reach it.`, 'ETIMEDOUT');
    case 'EDNS':
      return new SmtpError(`The relay host ${config.host} could not be found (DNS). Check yourphr.mail.provider.smtp.host.`, 'EDNS');
    case 'ECONNECTION':
    case 'ESOCKET':
      if (/wrong version number|packet length too long|WRONG_VERSION/i.test(err.message)) {
        return new SmtpError(`The relay at ${where} does not speak TLS from the first byte. Turn secure off for port 587, or use port 465.`, 'ETLS');
      }
      return new SmtpError(`Could not connect to the relay at ${where} (${err.message}). Check the host and port, and that this instance can reach it.`, err.code);
    default:
      if (err.responseCode && err.responseCode >= 500) return new SmtpError(`The relay at ${where} rejected the message.${said}`, 'EMESSAGE');
      return new SmtpError(`Sending through the relay at ${where} failed: ${err.message}`, err.code ?? 'EUNKNOWN');
  }
}
