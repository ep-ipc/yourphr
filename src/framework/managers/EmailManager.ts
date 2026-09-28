/**
 * Outbound email (yourphr#536): the one door any feature uses to send mail — first the stale-backup
 * alert (yourphr#789), through notification escalation. Ported from ngdpbase's EmailManager, with
 * the same configuration keys under the `yourphr.` prefix and the same two transports.
 *
 * Where it differs from ngdpbase, and why:
 *
 *   - Configuration is read on EVERY send, not once at boot. Here settings are changed on Admin ->
 *     Configuration while the instance runs (yourphr#472), and the converter settings set the
 *     precedent: "read on every upload, so no restart". An operator fixing a relay password, then
 *     pressing "Send a test message", must be testing what they just typed.
 *   - OFF means off. ngdpbase leaves `mail.enabled` for its callers to check; here send() itself
 *     honours it, so no future feature can forget. A message sent while mail is off is recorded in
 *     the log — who and what, never the body — and reported as not sent, rather than failing: a
 *     feature that would send mail degrades to a log line, which is what #536 asks of an
 *     unconfigured instance. The public demo must never email a stranger, and that is the default.
 *   - Sending acts for someone, so it takes the request context: the system (a scheduler, an alert)
 *     or an admin. A member cannot make the instance send mail.
 *   - Refusals name the fix (ApiError with the cause), because an operator reads them on screen.
 */
import { BaseManager, type BackupData } from '../BaseManager.js';
import type { Engine } from '../Engine.js';
import { ApiError, type ApiContext } from '../ApiContext.js';
import { SmtpError } from '../../http/index.js';
import { BaseMailProvider, ConsoleMailProvider, type MailMessage } from '../providers/BaseMailProvider.js';
import { NodemailerMailProvider } from '../providers/NodemailerMailProvider.js';
import { addressOf, isEmailAddress } from '../email-address.js';

declare module '../Engine.js' {
  interface ManagerRegistry {
    email: EmailManager;
  }
}

/** The mail settings as they stand right now. The password is never part of this. */
export interface MailSettings {
  enabled: boolean;
  provider: string;
  /** The effective sender: smtp.from when set, else mail.from. */
  from: string;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordSet: boolean };
}

/** What the Admin screen shows: the settings, where mail would go, and what stops it. */
export interface MailStatus extends Omit<MailSettings, 'smtp'> {
  smtp?: MailSettings['smtp'];
  destination: string;
  /** Sentences, each naming a setting to fix. Empty when a message could be sent. */
  problems: string[];
}

export interface SendResult {
  /** True when a transport accepted it: the relay for smtp, the log for console. */
  sent: boolean;
  provider: string;
  destination: string;
  /** Why it was not sent, when it was not. */
  reason?: string;
}

/** Builds the transport for the settings of the moment. Tests pass their own. */
export type MailProviderFactory = (settings: MailSettings, pass: string) => BaseMailProvider;


export class EmailManager extends BaseManager {
  readonly name = 'email';
  override readonly dependsOn = ['configuration'] as const;
  private readonly providerFor: MailProviderFactory;

  constructor(
    engine: Engine,
    private readonly log: (line: string) => void = () => undefined,
    providerFor?: MailProviderFactory
  ) {
    super(engine);
    this.providerFor = providerFor ?? ((settings, pass) => (settings.provider === 'smtp'
      ? new NodemailerMailProvider({ host: settings.smtp.host, port: settings.smtp.port, secure: settings.smtp.secure, user: settings.smtp.user || undefined, pass: pass || undefined })
      : new ConsoleMailProvider(this.log)));
  }

  private get cfg() { return this.engine.managers.configuration; }

  override async initialize(config: Record<string, unknown> = {}): Promise<void> {
    await super.initialize(config);
    // ngdpbase's boot warnings, once, so an operator reading the log learns what mail will do.
    const s = this.settings();
    const where = s.provider === 'smtp' ? `smtp ${s.smtp.host || '(no host)'}:${s.smtp.port}` : 'console (the server log)';
    this.log(`mail: ${s.enabled ? 'ON' : 'off'}, provider ${where}${s.from ? `, from ${s.from}` : ''}`);
    if (s.enabled) for (const p of this.problems(s)) this.log(`mail: ${p}`);
  }

  /** ngdpbase's isEnabled(): whether yourphr.mail.enabled is on. */
  isEnabled(): boolean {
    return this.cfg.getBool('yourphr.mail.enabled');
  }

  /** ngdpbase's getProviderName(): 'console' | 'smtp'. */
  getProviderName(): string {
    return this.settings().provider;
  }

  /** ngdpbase's getFrom(): smtp.from overrides mail.from. */
  getFrom(): string {
    return this.settings().from;
  }

  settings(): MailSettings {
    const c = this.cfg;
    const provider = c.getString('yourphr.mail.provider') === 'smtp' ? 'smtp' : 'console';
    return {
      enabled: c.getBool('yourphr.mail.enabled'),
      provider,
      from: (c.getString('yourphr.mail.provider.smtp.from') || c.getString('yourphr.mail.from')).trim(),
      smtp: {
        host: c.getString('yourphr.mail.provider.smtp.host').trim(),
        port: c.getInt('yourphr.mail.provider.smtp.port'),
        secure: c.getBool('yourphr.mail.provider.smtp.secure'),
        user: c.getString('yourphr.mail.provider.smtp.user').trim(),
        passwordSet: c.getString('yourphr.mail.provider.smtp.pass') !== '',
      },
    };
  }

  /** What stops a message from being sent, each naming the setting. Empty = ready. */
  problems(s: MailSettings = this.settings()): string[] {
    const out: string[] = [];
    const provider = this.cfg.getString('yourphr.mail.provider');
    if (provider !== 'smtp' && provider !== 'console') out.push(`yourphr.mail.provider is '${provider}', which is not a mail provider — use 'smtp' or 'console'.`);
    if (!s.from) out.push('No sender address: set yourphr.mail.from (or yourphr.mail.provider.smtp.from).');
    else if (!isEmailAddress(addressOf(s.from))) out.push(`The sender address '${s.from}' is not an email address (yourphr.mail.from).`);
    if (s.provider === 'smtp') {
      if (!s.smtp.host) out.push('No SMTP relay: set yourphr.mail.provider.smtp.host.');
      if (!Number.isInteger(s.smtp.port) || s.smtp.port < 1 || s.smtp.port > 65535) out.push(`yourphr.mail.provider.smtp.port (${s.smtp.port}) is not a port number.`);
      if (s.smtp.secure && s.smtp.port === 587) out.push('Port 587 uses STARTTLS: turn yourphr.mail.provider.smtp.secure off (secure is for port 465).');
      if (s.smtp.user && !s.smtp.passwordSet) out.push('yourphr.mail.provider.smtp.user is set but the password is empty.');
    }
    return out;
  }

  /** For Admin: the settings, where mail goes, and what is wrong. Admin only. */
  status(ctx: ApiContext): MailStatus {
    ctx.require('admin-system');
    const s = this.settings();
    return {
      enabled: s.enabled,
      provider: s.provider,
      from: s.from,
      ...(s.provider === 'smtp' ? { smtp: s.smtp } : {}),
      destination: s.provider === 'smtp' ? `${s.smtp.host || '(no host)'}:${s.smtp.port} (${s.smtp.secure ? 'TLS' : 'STARTTLS required'})` : 'the server log',
      problems: this.problems(s),
    };
  }

  /**
   * Send one message. The system (an alert, a scheduler) or an admin may; a member may not. While
   * mail is off this records who and what in the log and returns `sent: false` — never the body.
   */
  async send(ctx: ApiContext, message: MailMessage): Promise<SendResult> {
    if (ctx.system === '') ctx.require('admin-system');
    return this.deliver(message, false);
  }

  /** ngdpbase's sendTo(): build and send in one call. */
  async sendTo(ctx: ApiContext, to: string, subject: string, text: string, html?: string): Promise<SendResult> {
    return this.send(ctx, { to, subject, text, ...(html ? { html } : {}) });
  }

  /**
   * Admin -> "Send a test message": proves the relay with the settings as they are now. Unlike send(),
   * it sends even while mail is off — an operator should be able to check a relay BEFORE turning mail
   * on. Like send(), a failure throws an ApiError naming the cause.
   */
  async sendTest(ctx: ApiContext, to: string): Promise<SendResult> {
    ctx.require('admin-system');
    const at = new Date().toISOString();
    return this.deliver({
      to,
      subject: 'Test message',
      text: `This is a test message from your YourPHR instance, sent at ${at} by ${ctx.username || 'an admin'} from Admin -> Configuration.\n\nIf you are reading it, this instance can send email. Nothing else is needed.`,
    }, true);
  }

  /** The configured prefix in front of a subject (yourphr.mail.subject-prefix), never twice. */
  private subjectOf(subject: string): string {
    const prefix = this.cfg.getString('yourphr.mail.subject-prefix');
    return prefix !== '' && !subject.startsWith(prefix) ? prefix + subject : subject;
  }

  private async deliver(original: MailMessage, test: boolean): Promise<SendResult> {
    const message = { ...original, subject: this.subjectOf(String(original.subject ?? '')) };
    const to = String(message.to ?? '').trim();
    if (!isEmailAddress(to)) throw new ApiError(400, `'${to}' is not an email address.`);
    const s = this.settings();
    const pass = this.cfg.getString('yourphr.mail.provider.smtp.pass');
    if (!s.enabled && !test) {
      const reason = 'Outbound mail is off (yourphr.mail.enabled).';
      this.log(`mail: off — not sent: to=${to} subject=${JSON.stringify(message.subject)}`);
      return { sent: false, provider: s.provider, destination: 'nowhere', reason };
    }
    const problems = this.problems(s);
    if (problems.length > 0) throw new ApiError(400, problems.join(' '));
    let provider: BaseMailProvider;
    try {
      provider = this.providerFor(s, pass);
    } catch (err) {
      throw new ApiError(400, (err as Error).message);
    }
    try {
      await provider.send({ ...message, to, from: message.from?.trim() || s.from });
    } catch (err) {
      const cause = err instanceof SmtpError ? err.message : `Sending failed: ${(err as Error).message}`;
      this.log(`mail: NOT sent via ${provider.name} to=${to} subject=${JSON.stringify(message.subject)}: ${cause}`);
      throw new ApiError(502, cause);
    }
    this.log(`mail: sent via ${provider.name} (${provider.destination}) to=${to} subject=${JSON.stringify(message.subject)}`);
    return { sent: true, provider: provider.name, destination: provider.destination };
  }

  /** Nothing of its own to copy: the settings are configuration's, and they travel with it. */
  async backup(): Promise<BackupData> {
    return { manager: this.name, takenAt: new Date().toISOString() };
  }

  async restore(): Promise<void> { /* nothing to bring back */ }
}
