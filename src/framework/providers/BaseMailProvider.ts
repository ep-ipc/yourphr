/**
 * Mail transport (yourphr#536), ported from ngdpbase's `MailProvider` (src/mail/MailProvider.ts):
 * the same message shape and the same two transports, selected by `yourphr.mail.provider`.
 *
 *   console — writes the message to the server log (the default; development, the E2E suite, and
 *             any instance with no relay). A feature that sends mail degrades to a log line.
 *   smtp    — NodemailerMailProvider, through the SMTP capability in src/http.
 *
 * YourPHR's providers are abstract classes rather than ngdpbase's interface, like every other
 * provider here, so a transport also names itself for the boot log and the Admin screen.
 */

/** An outbound email message. ngdpbase's MailMessage, plus an optional sender the manager fills in. */
export interface MailMessage {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  html?: string;
  /** The sender; the manager supplies the configured one when this is absent. */
  from?: string;
}

export abstract class BaseMailProvider {
  /** 'console' | 'smtp' — what the boot log and the Admin screen call this transport. */
  abstract readonly name: string;
  /** Where mail goes, in words — "the server log", "smtp.example.org:587 (STARTTLS required)". */
  abstract readonly destination: string;
  /** Deliver one message, or throw an error that names the cause. `from` is always set by then. */
  abstract send(message: MailMessage & { from: string }): Promise<void>;
}

/**
 * The log instead of a relay. It prints the whole message, body included, which is its purpose:
 * an admin chose it. While mail is OFF nothing reaches a provider at all — the manager logs only
 * who and what the message was, never its body.
 */
export class ConsoleMailProvider extends BaseMailProvider {
  readonly name = 'console';
  readonly destination = 'the server log';

  constructor(private readonly log: (line: string) => void) {
    super();
  }

  async send(message: MailMessage & { from: string }): Promise<void> {
    this.log(`mail (console provider, not sent): from=${message.from} to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
  }
}
