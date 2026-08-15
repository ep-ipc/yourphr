# Email setup

YourPHR sends no email until you configure it, and a fresh instance never fails trying — with no relay set up, a message is written to the log instead ([#536](https://github.com/jwilleke/yourphr/issues/536)).

Adapted from [`jwilleke/ngdpbase`](https://github.com/jwilleke/ngdpbase/blob/main/docs/admin/email-setup.md), which solved the same problem for a wiki. The relay advice below is identical because SMTP is; the differences are noted where they matter.

## Two switches before anything is sent

| Key | Default | Meaning |
|---|---|---|
| `mail.enabled` | `false` | Master switch. Nothing leaves the instance while this is off. |
| `mail.provider` | `"console"` | `console` writes the message to the log; `smtp` sends it. |

**Both must change** before mail is delivered. That is deliberate: the public demo must never email strangers, and development and the E2E suite need no relay at all.

Set these in **Admin → Configuration**, not in deployment yaml ([#472](https://github.com/jwilleke/yourphr/issues/472)) — environment variables are for bootstrap and secrets.

## SMTP settings

| Key | Default | Description |
|---|---|---|
| `mail.from` | `""` | Sender address. Required when sending. `YourPHR <phr@example.org>` is valid. |
| `mail.smtp.host` | `""` | Relay hostname. Required when sending. |
| `mail.smtp.port` | `587` | `587` for STARTTLS, `465` for implicit TLS. |
| `mail.smtp.secure` | `false` | `true` only for port 465. |
| `mail.smtp.user` | `""` | Username. Most relays require one. |
| `mail.smtp.pass` | `""` | Password or API key. **Masked in Admin and never served to a browser.** |

`mail.smtp.pass` is on the instance's `secret` list, so it is redacted in logs and hidden on the configuration screen until an admin explicitly reveals it. Prefer an API key scoped to sending over a full account password.

## Relays that work

Mail sent directly from a home IP address is usually dropped or filed as spam, so in practice `mail.smtp.host` points at a relay you already have.

| Provider | Host | Port | Notes |
|---|---|---|---|
| **Resend** | `smtp.resend.com` | 587 | User `resend`, pass = API key. Free tier ~100/day. |
| **SendGrid** | `smtp.sendgrid.net` | 587 | User `apikey`, pass = API key. |
| **Gmail** | `smtp.gmail.com` | 587 | Requires an **App Password**, not your Google account password. |
| **AWS SES** | region-specific | 587 | IAM **SMTP** credentials, not AWS access keys. |
| **Mailhog** | `localhost` | 1025 | No auth. Development only. |
| **Postfix** | your host | 587 | Relay or smarthost as configured. |

### Gmail App Password

1. Enable 2FA on the Google account.
2. **Google Account → Security → App passwords**.
3. Generate one for "Mail / Other".
4. Use the 16-character value as `mail.smtp.pass`, without spaces.

Your ordinary Google password will be rejected. That refusal is reported as a credentials error naming `mail.smtp.user` and `mail.smtp.pass`.

## Sending from your own domain

Recipients will reject mail that does not authenticate. Three DNS records:

| Record | Purpose | Who sets it |
|---|---|---|
| **SPF** | Authorises your relay to send for the domain | You, in DNS |
| **DKIM** | Signs outgoing mail | Your relay provider gives you the record |
| **DMARC** | What receivers do with failures — start at `p=none` | You, in DNS |

Managed relays walk you through these during onboarding.

## Certificates are always verified

There is **no option to skip certificate verification**, and that is a deliberate difference from the ngdpbase original. On a wiki, disabling it is a development convenience. Here the channel would carry medical records, and an instance that quietly accepts any certificate is worse than one that refuses to send.

If a relay presents an untrusted certificate, fix the certificate or use a different relay.

STARTTLS is used automatically on port 587 whenever the relay offers it. A relay that does **not** offer it still works — local test relays like Mailhog do not — but the server logs a warning that the message will cross the network unencrypted.

## Troubleshooting

**Mail is logged instead of sent**
: `mail.enabled` is `false`, or `mail.provider` is still `console`. Both must change.

**`mail.provider is "smtp" but mail.smtp.host is empty`**
: SMTP was selected without a relay. This is a startup-time error rather than silence, because a half-configured relay is a mistake an operator can fix.

**`the mail relay rejected the credentials`**
: Wrong username or password. On Gmail this almost always means an account password was used instead of an App Password.

**`could not reach the mail relay`**
: Wrong host or port, or outbound SMTP is blocked. Many home ISPs block port 25 and some block 587 — try 465 with `mail.smtp.secure: true`.

**`the relay rejected the sender address`**
: `mail.from` is not an address the relay is willing to send as. Managed relays usually require a verified domain or sender.

## What uses it

- [#524](https://github.com/jwilleke/yourphr/issues/524) — sending a report by email, which adds its own warning, rate limiting and record of what was sent
- [#507](https://github.com/jwilleke/yourphr/issues/507) — password reset, which is operator-assisted while there is no mail path
