/**
 * SMTP transport (yourphr#536), ngdpbase's NodemailerMailProvider. The connection itself — TLS
 * required, certificates verified, one relay an admin named — is the SmtpRelay capability in
 * src/http, because that directory is the network's only door (scripts/check-http-boundary.sh).
 */
import { SmtpRelay, type SmtpRelayConfig } from '../../http/index.js';
import { BaseMailProvider, type MailMessage } from './BaseMailProvider.js';

export class NodemailerMailProvider extends BaseMailProvider {
  readonly name = 'smtp';
  private readonly relay: SmtpRelay;

  constructor(config: SmtpRelayConfig) {
    super();
    this.relay = new SmtpRelay(config);
  }

  get destination(): string {
    return this.relay.destination;
  }

  async send(message: MailMessage & { from: string }): Promise<void> {
    await this.relay.send({ from: message.from, to: message.to, subject: message.subject, text: message.text, ...(message.html ? { html: message.html } : {}) });
  }
}
