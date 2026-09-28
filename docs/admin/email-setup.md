# Email setup

YourPHR sends no email until an admin turns it on, and a fresh instance never fails trying. While mail is off, a message the instance would have sent is noted in the server log (who it was for and its subject, never its contents) and nothing leaves the instance ([#536](https://github.com/jwilleke/yourphr/issues/536)).

The mail code is ngdpbase's `EmailManager`, with the same settings under the `yourphr.` prefix. The relay advice below is the same as [ngdpbase's email setup](https://github.com/jwilleke/ngdpbase/blob/main/docs/admin/email-setup.md) because SMTP is the same. Where YourPHR differs, this page says so.

## Where to set it

__Admin → Configuration__. The __Email__ card at the top says whether this instance sends mail, where it would go, and what is stopping it. It can also send a test message. The settings themselves are the `yourphr.mail.*` rows on the same page.

Do not put these in deployment yaml ([#472](https://github.com/jwilleke/yourphr/issues/472)); environment variables are for bootstrap and secrets. The settings are read each time a message is sent, so a change takes effect at once, with no restart.

## Two switches before anything is sent

| Key | Default | Meaning |
|---|---|---|
| `yourphr.mail.enabled` | `false` | Master switch. While it is off, nothing leaves the instance. |
| `yourphr.mail.provider` | `"console"` | `console` writes each message to the server log; `smtp` sends it through a relay. |

To deliver real mail, __both must change__: `enabled` on, and `provider` set to `smtp`. That is deliberate. The public demo must never email strangers, and development and the test suites need no relay at all. With `enabled` on and `provider` still `console`, the whole message, contents included, is written to the log. That is the point of the console provider, so choose it only on an instance where that is acceptable.

## SMTP settings

| Key | Default | Description |
|---|---|---|
| `yourphr.mail.from` | `""` | Sender address. Required. `YourPHR <phr@example.org>` is fine. |
| `yourphr.mail.provider.smtp.from` | `""` | Overrides `mail.from` for SMTP, if set. |
| `yourphr.mail.subject-prefix` | `"[YourPHR] "` | Put in front of every subject, so this instance's mail is easy to spot and filter. Empty for none. |
| `yourphr.mail.provider.smtp.host` | `""` | Relay hostname. Required for `smtp`. |
| `yourphr.mail.provider.smtp.port` | `587` | `587` for STARTTLS, `465` for TLS from the first byte. |
| `yourphr.mail.provider.smtp.secure` | `false` | `true` only for port 465. |
| `yourphr.mail.provider.smtp.user` | `""` | Username. Most relays require one. |
| `yourphr.mail.provider.smtp.pass` | `""` | Password or API key. |

Rather than typing the password into the Configuration screen, you can put it in the environment as `YOURPHR_MAIL_PROVIDER_SMTP_PASS` (in `<data>/.env` or a Kubernetes Secret). The environment then owns the setting, so the screen shows it read-only and it is never written to the configuration file.

`yourphr.mail.provider.smtp.pass` is on the instance's secret list (`yourphr.config.secret-keys`), so the Configuration screen hides it until an admin explicitly reveals it. It is never included in the Email card, in any API response, or in an error message. It is stored in `app-custom-config.json` on the data volume like every other setting, so prefer an API key that can only send mail over a full account password.

## Mail is always encrypted, and certificates are always verified

- __Port 465 with `secure` on__: TLS from the first byte.
- __Any other port__: the relay must offer STARTTLS. If it does not, __nothing is sent__, not even the password, and the error says so.
- __Certificates are verified__, and there is no setting to turn that off. A relay whose certificate cannot be verified is refused.

This differs from ngdpbase on purpose. On a wiki, skipping verification or sending unencrypted is a development convenience. Here the message can concern someone's medical records, and not sending is better than sending over a connection nobody checked. If a relay's certificate is untrusted, fix the certificate or use a different relay.

One consequence: a local test relay without TLS, like Mailhog, will be refused. For development, use the `console` provider instead. Messages go to the log, which is what you want there anyway.

## Relays that work

Mail sent directly from a home IP address is usually dropped or filed as spam, so in practice `smtp.host` points at a relay you already have.

| Provider | Host | Port | Notes |
|---|---|---|---|
| __Resend__ | `smtp.resend.com` | 587 | User `resend`, password = API key. |
| __SendGrid__ | `smtp.sendgrid.net` | 587 | User `apikey`, password = API key. |
| __Gmail__ | `smtp.gmail.com` | 587 | Needs an __App Password__, not your Google account password. |
| __AWS SES__ | region-specific | 587 | IAM __SMTP__ credentials, not AWS access keys. |
| __Postfix__ | your host | 587 | Must offer STARTTLS with a certificate this instance trusts. |

### Gmail App Password

1. Turn on 2-step verification for the Google account.
2. Go to __Google Account → Security → App passwords__.
3. Create one for "Mail / Other".
4. Use the 16-character value as `yourphr.mail.provider.smtp.pass`, without spaces.

Your ordinary Google password is refused, and that refusal is reported as a username-or-password error.

## Sending from your own domain

Receiving servers reject mail that does not authenticate. You need three DNS records:

| Record | Purpose | Who sets it |
|---|---|---|
| __SPF__ | Allows your relay to send for the domain | You, in DNS |
| __DKIM__ | Signs outgoing mail | Your relay provider gives you the record |
| __DMARC__ | Tells receivers what to do with failures; start at `p=none` | You, in DNS |

Managed relays walk you through these when you sign up.

## Check it with a test message

On the Email card, enter an address and press __Send a test message__. It uses the settings as they are right now, and it works __even while mail is off__, so you can prove the relay before turning mail on. It reports one of:

- __Sent__, with the relay it went through. Check that inbox, including spam.
- __Written to the server log__: the provider is still `console`.
- __An error naming the cause__, one of those below.

## Troubleshooting

Each error names the setting to fix.

__"Outbound mail is off (yourphr.mail.enabled)."__
: A feature tried to send while mail was off. That is expected until you turn it on.

__"No sender address: set yourphr.mail.from …"__
: No sender is configured. Nothing is sent without one.

__"No SMTP relay: set yourphr.mail.provider.smtp.host."__
: `smtp` was chosen without a relay.

__"… refused the username or password (yourphr.mail.provider.smtp.user / .pass)."__
: Wrong credentials. On Gmail this almost always means the account password was used instead of an App Password.

__"… did not offer an encrypted connection (STARTTLS), so nothing was sent."__
: The relay does not support STARTTLS. Use one that does, or port 465 with `secure` on.

__"… does not speak TLS from the first byte."__
: `secure` is on, but the relay expects STARTTLS. Turn `secure` off for port 587.

__"… presented a certificate that could not be verified …"__
: The relay's certificate is self-signed, expired, or for a different name. Fix the certificate; there is no override.

__"Could not connect to the relay …" / "… did not answer in time."__
: Wrong host or port, or outbound mail is blocked on this network. Many ISPs block port 25, and some block 587; try 465 with `secure` on.

__"… refused the sender or recipient address …"__
: The relay will not send as `yourphr.mail.from`. Managed relays usually require a verified domain or sender.

## What uses it

- [#789](https://github.com/jwilleke/yourphr/issues/789): the backup alerts. With the schedule on and no backup succeeding in 49 hours (`yourphr.backup.alert.stale-hours`; 193 for a weekly schedule, `stale-hours-weekly`), every admin gets an error notice. With no backup in 15 days (`yourphr.backup.alert.unscheduled-days`), they get a warning, even if the schedule is off. Both appear as a banner on every page. The error is also emailed when escalation is on (`yourphr.notifications.escalation.enabled`) to each admin who has added an email address on Settings ([#792](https://github.com/jwilleke/yourphr/issues/792)).

For an alert email to arrive, three things must be set: mail on and working (this page), `yourphr.notifications.escalation.enabled` on, and an email address on at least one admin's Settings page.

Sending a report by email is still done by the patient, not the instance ([#687](https://github.com/jwilleke/yourphr/issues/687)). Password reset needs no email: it is done through account recovery or by an admin ([#507](https://github.com/jwilleke/yourphr/issues/507)).
