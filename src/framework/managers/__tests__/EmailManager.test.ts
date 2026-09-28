import { beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../Engine.js';
import { ApiContext } from '../../ApiContext.js';
import { ConfigurationManager } from '../../ConfigurationManager.js';
import { PolicyManager } from '../PolicyManager.js';
import { FakeConfigProvider } from '../../providers/__tests__/FakeConfigProvider.js';
import { EmailManager, type MailSettings } from '../EmailManager.js';
import { BaseMailProvider, ConsoleMailProvider, type MailMessage } from '../../providers/BaseMailProvider.js';
import { SmtpError } from '../../../http/index.js';

/** A transport that records, or fails the way a relay does. */
class FakeMailProvider extends BaseMailProvider {
  readonly name = 'smtp';
  readonly destination = 'relay.test:587 (STARTTLS required)';
  sent: (MailMessage & { from: string })[] = [];
  failWith?: Error;
  async send(message: MailMessage & { from: string }): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }
}

let engine: Engine;
let email: EmailManager;
let relay: FakeMailProvider;
let built: { settings: MailSettings; pass: string }[];
let lines: string[];
let admin: ApiContext;
let alice: ApiContext;
let system: ApiContext;

async function boot(custom: Record<string, unknown> = {}): Promise<void> {
  engine = new Engine();
  relay = new FakeMailProvider();
  built = [];
  lines = [];
  email = new EmailManager(engine, (line) => lines.push(line), (settings, pass) => {
    built.push({ settings, pass });
    return settings.provider === 'smtp' ? relay : new ConsoleMailProvider((line) => lines.push(line));
  });
  engine.register('configuration', new ConfigurationManager(engine, new FakeConfigProvider(custom as never), { env: {} })).register('policy', new PolicyManager(engine)).register('email', email);
  await engine.initialize();
  admin = ApiContext.from({ username: 'root', role: 'admin' }, engine);
  alice = ApiContext.from({ username: 'alice', role: 'user' }, engine);
  system = ApiContext.system('backup-alert', 'backup-alert', engine);
}

const SMTP = {
  'yourphr.mail.enabled': true,
  'yourphr.mail.provider': 'smtp',
  'yourphr.mail.from': 'YourPHR <phr@example.org>',
  'yourphr.mail.provider.smtp.host': 'relay.test',
  'yourphr.mail.provider.smtp.user': 'phr',
  'yourphr.mail.provider.smtp.pass': 's3cret',
};

beforeEach(async () => { await boot(); });

describe('EmailManager — the one door to outbound mail', () => {
  it('ships off, on the console provider, with no sender — ngdpbase defaults under yourphr.', () => {
    expect(email.isEnabled()).toBe(false);
    expect(email.getProviderName()).toBe('console');
    expect(email.getFrom()).toBe('');
    expect(lines[0]).toBe('mail: off, provider console (the server log)');
  });

  it('while off, a send is logged — who and what, never the body — and reported as not sent', async () => {
    const result = await email.sendTo(system, 'admin@example.org', 'Backups are stale', 'PRIVATE BODY');
    expect(result).toEqual({ sent: false, provider: 'console', destination: 'nowhere', reason: 'Outbound mail is off (yourphr.mail.enabled).' });
    expect(built).toEqual([]);
    expect(lines.at(-1)).toBe('mail: off — not sent: to=admin@example.org subject="Backups are stale"');
    expect(lines.join('\n')).not.toContain('PRIVATE BODY');
  });

  it('only the system or an admin may send; a member may not', async () => {
    await expect(email.sendTo(alice, 'x@example.org', 's', 't')).rejects.toMatchObject({ status: 403 });
    await expect(email.sendTo(admin, 'x@example.org', 's', 't')).resolves.toMatchObject({ sent: false });
    await expect(email.sendTo(system, 'x@example.org', 's', 't')).resolves.toMatchObject({ sent: false });
    expect(() => email.status(alice)).toThrow();
    await expect(email.sendTest(alice, 'x@example.org')).rejects.toMatchObject({ status: 403 });
  });

  it('on and smtp: sends through the relay with the configured sender, reading settings at send time', async () => {
    await boot(SMTP);
    const result = await email.sendTo(system, 'admin@example.org', 'Backups are stale', 'body');
    expect(result).toEqual({ sent: true, provider: 'smtp', destination: 'relay.test:587 (STARTTLS required)' });
    expect(relay.sent).toEqual([{ to: 'admin@example.org', subject: 'Backups are stale', text: 'body', from: 'YourPHR <phr@example.org>' }]);
    expect(built[0]!.pass).toBe('s3cret');
    expect(built[0]!.settings.smtp).toEqual({ host: 'relay.test', port: 587, secure: false, user: 'phr', passwordSet: true });
    // An admin changes the relay on the Configuration screen: the next send uses it, no restart.
    engine.managers.configuration.set('yourphr.mail.provider.smtp.host', 'other.test');
    engine.managers.configuration.set('yourphr.mail.provider.smtp.from', 'alerts@example.org');
    await email.sendTo(system, 'admin@example.org', 's', 't');
    expect(built[1]!.settings.smtp.host).toBe('other.test');
    expect(relay.sent[1]!.from).toBe('alerts@example.org');
  });

  it('refuses before connecting when a setting is missing, naming each one', async () => {
    await boot({ ...SMTP, 'yourphr.mail.from': '', 'yourphr.mail.provider.smtp.host': '', 'yourphr.mail.provider.smtp.pass': '' });
    const refusal = email.sendTo(system, 'admin@example.org', 's', 't');
    await expect(refusal).rejects.toMatchObject({ status: 400 });
    await expect(refusal).rejects.toThrow(/set yourphr\.mail\.from.*smtp\.host.*password is empty/s);
    expect(built).toEqual([]);
    expect(lines.some((l) => l.startsWith('mail: No SMTP relay'))).toBe(true);
  });

  it('flags secure on port 587, a bad port, a bad sender and an unknown provider', () => {
    engine.managers.configuration.set('yourphr.mail.provider', 'smtp');
    engine.managers.configuration.set('yourphr.mail.from', 'not-an-address');
    engine.managers.configuration.set('yourphr.mail.provider.smtp.host', 'relay.test');
    engine.managers.configuration.set('yourphr.mail.provider.smtp.secure', true);
    expect(email.problems()).toEqual([
      "The sender address 'not-an-address' is not an email address (yourphr.mail.from).",
      'Port 587 uses STARTTLS: turn yourphr.mail.provider.smtp.secure off (secure is for port 465).',
    ]);
    engine.managers.configuration.set('yourphr.mail.provider.smtp.port', 0);
    expect(email.problems()).toContain('yourphr.mail.provider.smtp.port (0) is not a port number.');
    engine.managers.configuration.set('yourphr.mail.provider', 'sendgrid');
    expect(email.problems()[0]).toBe("yourphr.mail.provider is 'sendgrid', which is not a mail provider — use 'smtp' or 'console'.");
  });

  it('a relay failure is a 502 carrying the cause, and is logged without the body', async () => {
    await boot(SMTP);
    relay.failWith = new SmtpError('The relay at relay.test:587 refused the username or password (yourphr.mail.provider.smtp.user / .pass).', 'EAUTH');
    await expect(email.sendTo(system, 'admin@example.org', 'subject', 'PRIVATE BODY')).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/refused the username or password/) });
    expect(lines.at(-1)).toMatch(/^mail: NOT sent via smtp to=admin@example\.org subject="subject": The relay at relay\.test:587 refused/);
    expect(lines.join('\n')).not.toContain('PRIVATE BODY');
    expect(lines.join('\n')).not.toContain('s3cret');
  });

  it('refuses a recipient that is not an address', async () => {
    await boot(SMTP);
    await expect(email.sendTo(system, 'nobody', 's', 't')).rejects.toMatchObject({ status: 400, message: "'nobody' is not an email address." });
    await expect(email.sendTo(system, 'a@b.org, c@d.org', 's', 't')).rejects.toMatchObject({ status: 400 });
    expect(relay.sent).toEqual([]);
  });

  it('a test message sends even while mail is off, so a relay can be checked before turning it on', async () => {
    await boot({ ...SMTP, 'yourphr.mail.enabled': false });
    const result = await email.sendTest(admin, 'root@example.org');
    expect(result).toMatchObject({ sent: true, provider: 'smtp' });
    expect(relay.sent[0]).toMatchObject({ to: 'root@example.org', subject: 'YourPHR test message', from: 'YourPHR <phr@example.org>' });
    expect(relay.sent[0]!.text).toContain('sent at');
    expect(relay.sent[0]!.text).toContain('by root');
  });

  it('on with the console provider, the whole message goes to the log — the admin chose that', async () => {
    await boot({ 'yourphr.mail.enabled': true, 'yourphr.mail.from': 'phr@example.org' });
    const result = await email.sendTo(system, 'admin@example.org', 'Backups are stale', 'the body');
    expect(result).toEqual({ sent: true, provider: 'console', destination: 'the server log' });
    expect(lines.some((l) => l.includes('to=admin@example.org') && l.includes('the body'))).toBe(true);
  });

  it('status shows the settings, where mail goes and what is wrong — never the password', async () => {
    await boot(SMTP);
    const status = email.status(admin);
    expect(status).toEqual({
      enabled: true,
      provider: 'smtp',
      from: 'YourPHR <phr@example.org>',
      smtp: { host: 'relay.test', port: 587, secure: false, user: 'phr', passwordSet: true },
      destination: 'relay.test:587 (STARTTLS required)',
      problems: [],
    });
    expect(JSON.stringify(status)).not.toContain('s3cret');
  });

  it('has nothing of its own to back up: its settings travel with configuration', async () => {
    await expect(email.backup()).resolves.toMatchObject({ manager: 'email' });
    expect(engine.registered).toEqual(['configuration', 'policy', 'email']);
  });
});
