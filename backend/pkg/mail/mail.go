// Package mail is the single outbound-email path for YourPHR (#536).
//
// It exists once so the features that need mail — sending a report (#524), password reset (#507) —
// do not each invent their own transport and their own way of failing.
//
// The design is adapted from jwilleke/ngdpbase docs/admin/email-setup.md, which solved this for a
// wiki. SMTP is the stable part, so only the transport differs (net/smtp rather than nodemailer).
// Two of its decisions are carried over deliberately:
//
//   - CONSOLE IS THE DEFAULT PROVIDER. With no relay configured a message is written to the log
//     rather than returning an error, so mail is never "broken": development and the E2E suite need
//     no relay, and a feature that sends mail degrades to a log line instead of a failure.
//   - MAIL IS DISABLED BY DEFAULT. The public demo must never email strangers, and that is the
//     default rather than something an operator has to remember to turn off.
package mail

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/smtp"
	"strings"
	"time"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/sirupsen/logrus"
)

// Config keys. Catalogued in backend/pkg/config/app-default-config.json.
const (
	KeyEnabled  = "mail.enabled"
	KeyProvider = "mail.provider"
	KeyFrom     = "mail.from"
	KeySMTPHost = "mail.smtp.host"
	KeySMTPPort = "mail.smtp.port"
	// KeySMTPSecure selects implicit TLS (465) over STARTTLS (587).
	KeySMTPSecure = "mail.smtp.secure"
	KeySMTPUser   = "mail.smtp.user"
	// KeySMTPPass is on the `secret` list, so it is masked in Admin -> Configuration and never
	// served to a browser. Read it through config.GetSecret so it redacts in logs.
	KeySMTPPass = "mail.smtp.pass"
)

const (
	ProviderConsole = "console"
	ProviderSMTP    = "smtp"
)

// Message is one email. Deliberately small: this package moves bytes, it does not compose content.
type Message struct {
	To      []string
	Subject string
	// Body is plain text.
	Body string
	// Attachments are what a patient is usually actually sending — the record itself (#524).
	Attachments []Attachment
}

// Attachment is a file carried by a Message.
type Attachment struct {
	Filename    string
	ContentType string
	Content     []byte
}

// Sender delivers a Message, or explains why it could not.
type Sender interface {
	Send(msg Message) error
	// Describe names the active transport for an operator ("console", "smtp smtp.example.com:587").
	Describe() string
}

// New builds the Sender an instance is configured for.
//
// Never returns an error for "not configured": that is the console provider's job. An error here
// means the configuration is present but WRONG — SMTP selected with no host, say — which an
// operator can act on, unlike silence.
func New(appConfig config.Interface, logger *logrus.Entry) (Sender, error) {
	if !appConfig.GetBool(KeyEnabled) {
		return &consoleSender{logger: logger, reason: fmt.Sprintf("%s is false", KeyEnabled)}, nil
	}

	switch strings.ToLower(strings.TrimSpace(appConfig.GetString(KeyProvider))) {
	case "", ProviderConsole:
		return &consoleSender{logger: logger, reason: fmt.Sprintf("%s is %q", KeyProvider, ProviderConsole)}, nil

	case ProviderSMTP:
		host := strings.TrimSpace(appConfig.GetString(KeySMTPHost))
		if host == "" {
			return nil, fmt.Errorf("%s is %q but %s is empty", KeyProvider, ProviderSMTP, KeySMTPHost)
		}
		from := fromAddress(appConfig)
		if from == "" {
			return nil, fmt.Errorf("%s is %q but no sender address is set — set %s", KeyProvider, ProviderSMTP, KeyFrom)
		}
		// Refused at construction rather than per message: this comes from configuration, so a bad
		// value is wrong for every message that will ever be sent, and failing to start is a much
		// louder signal than a send that fails later for reasons nobody connects to a config edit.
		if headerUnsafe(from) {
			return nil, fmt.Errorf("%s contains a line break or control character", KeyFrom)
		}
		port := appConfig.GetInt(KeySMTPPort)
		if port <= 0 {
			port = 587
		}
		return &smtpSender{
			host:   host,
			port:   port,
			secure: appConfig.GetBool(KeySMTPSecure),
			user:   appConfig.GetString(KeySMTPUser),
			pass:   config.GetSecret(appConfig, KeySMTPPass),
			from:   from,
			logger: logger,
		}, nil

	default:
		return nil, fmt.Errorf("unknown %s %q — expected %q or %q",
			KeyProvider, appConfig.GetString(KeyProvider), ProviderConsole, ProviderSMTP)
	}
}

func fromAddress(appConfig config.Interface) string {
	return strings.TrimSpace(appConfig.GetString(KeyFrom))
}

// consoleSender writes the message to the log instead of sending it.
//
// This is what makes an unconfigured instance usable rather than broken. It logs the recipients and
// the subject but NOT the body: a body will eventually carry a reset link or a patient's own
// record, and neither belongs in a log file that gets shipped to a bug report.
type consoleSender struct {
	logger *logrus.Entry
	reason string
}

func (c *consoleSender) Send(msg Message) error {
	if err := msg.validate(); err != nil {
		return err
	}
	if c.logger != nil {
		c.logger.Infof("mail not sent (%s): would have delivered %q to %s",
			c.reason, msg.Subject, strings.Join(msg.To, ", "))
	}
	return nil
}

func (c *consoleSender) Describe() string { return fmt.Sprintf("console (%s)", c.reason) }

type smtpSender struct {
	host   string
	port   int
	secure bool
	user   string
	pass   config.Secret
	from   string
	logger *logrus.Entry
}

func (s *smtpSender) Describe() string { return fmt.Sprintf("smtp %s:%d", s.host, s.port) }

func (s *smtpSender) Send(msg Message) error {
	if err := msg.validate(); err != nil {
		return err
	}

	addr := net.JoinHostPort(s.host, fmt.Sprint(s.port))
	client, err := s.dial(addr)
	if err != nil {
		return fmt.Errorf("could not reach the mail relay at %s: %w", addr, err)
	}
	defer client.Close()

	if s.user != "" {
		auth := smtp.PlainAuth("", s.user, s.pass.Expose(), s.host)
		if err := client.Auth(auth); err != nil {
			// Names the setting to change rather than echoing the relay's terse refusal. Gmail in
			// particular rejects an account password here and wants an App Password.
			return fmt.Errorf("the mail relay rejected the credentials in %s/%s: %w", KeySMTPUser, KeySMTPPass, err)
		}
	}

	if err := client.Mail(s.from); err != nil {
		return fmt.Errorf("the relay rejected the sender address %q from %s: %w", s.from, KeyFrom, err)
	}
	for _, to := range msg.To {
		if err := client.Rcpt(to); err != nil {
			return fmt.Errorf("the relay rejected the recipient %q: %w", to, err)
		}
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("the relay refused the message body: %w", err)
	}
	if _, err := writer.Write(msg.render(s.from)); err != nil {
		return fmt.Errorf("could not write the message: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("the relay rejected the message: %w", err)
	}

	return client.Quit()
}

// dial opens the connection, in whichever of the two shapes relays actually use.
//
// Port 465 is implicit TLS: the socket is encrypted before a byte of SMTP. Port 587 is STARTTLS:
// plaintext, then upgraded. There is NO third option that skips certificate verification — on a
// wiki that is a development convenience, but this channel carries medical records, and a PHR that
// quietly accepts any certificate is worse than one that refuses to send.
func (s *smtpSender) dial(addr string) (*smtp.Client, error) {
	if s.secure {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: s.host})
		if err != nil {
			return nil, err
		}
		return smtp.NewClient(conn, s.host)
	}

	conn, err := net.DialTimeout("tcp", addr, 15*time.Second)
	if err != nil {
		return nil, err
	}
	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		conn.Close()
		return nil, err
	}
	// STARTTLS where the relay offers it. Mailhog and similar local test relays do not, and
	// requiring it would make development impossible; a real relay on 587 always advertises it.
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err := client.StartTLS(&tls.Config{ServerName: s.host}); err != nil {
			client.Close()
			return nil, fmt.Errorf("STARTTLS failed: %w", err)
		}
	} else if s.logger != nil {
		s.logger.Warnf("mail relay %s does not offer STARTTLS — this message will cross the network unencrypted", addr)
	}
	return client, nil
}

// headerUnsafe reports whether s cannot be written into a header field.
//
// A carriage return or newline ends the header and starts another one, so a value carrying either
// lets the caller write headers this package never intended — a Bcc to somebody else, or a blank
// line that ends the header block and takes over the body. With a patient's records attached that
// is a disclosure primitive, not a formatting bug.
//
// Other control characters are refused too. They have no legitimate place in a header field, and
// what a relay does with them is its own business rather than something to find out in production.
// Tab is allowed: it is legal folding whitespace.
func headerUnsafe(s string) bool {
	return strings.ContainsFunc(s, func(r rune) bool {
		return r == '\r' || r == '\n' || r == 0x7f || (r < 0x20 && r != '\t')
	})
}

// validate refuses a message the transport must not send.
//
// The CRLF checks are here rather than at the one call site that exists today, because render()
// writes To and Subject straight into headers and cannot refuse anything — it returns bytes. The
// current caller is safe only by accident of its own construction: a constant subject, and a
// recipient already through mail.ParseAddress. The second caller — a password reset, a share
// notification, a subject carrying a report name — inherits an obligation nobody told it about.
// That is the same shape as an authorization check every handler is expected to remember.
//
// Refusing rather than stripping is deliberate. A mangled header is a visible bug; a silently
// altered recipient list is a message delivered somewhere nobody chose.
func (m Message) validate() error {
	if len(m.To) == 0 {
		return fmt.Errorf("no recipient")
	}
	for _, to := range m.To {
		if strings.TrimSpace(to) == "" {
			return fmt.Errorf("empty recipient address")
		}
		if headerUnsafe(to) {
			return fmt.Errorf("recipient address contains a line break or control character")
		}
	}
	if strings.TrimSpace(m.Subject) == "" {
		return fmt.Errorf("no subject")
	}
	if headerUnsafe(m.Subject) {
		return fmt.Errorf("subject contains a line break or control character")
	}
	for _, attachment := range m.Attachments {
		// Rendered through %q, which escapes control characters, so this is not currently an
		// injection route. Refused anyway: the safety here is a property of one format verb in
		// another function, and that is too thin a thread to hang a filename on.
		if headerUnsafe(attachment.Filename) {
			return fmt.Errorf("attachment filename contains a line break or control character")
		}
	}
	return nil
}

// render builds the RFC 5322 message. CRLF line endings, because some relays reject bare LF.
//
// Plain text when there is nothing attached; multipart/mixed when there is. Base64 in 76-character
// lines, which is what RFC 2045 requires and what relays that reject long lines expect.
func (m Message) render(from string) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\n", from)
	fmt.Fprintf(&b, "To: %s\r\n", strings.Join(m.To, ", "))
	fmt.Fprintf(&b, "Subject: %s\r\n", m.Subject)
	fmt.Fprintf(&b, "Date: %s\r\n", time.Now().Format(time.RFC1123Z))
	b.WriteString("MIME-Version: 1.0\r\n")

	if len(m.Attachments) == 0 {
		b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
		b.WriteString(strings.ReplaceAll(m.Body, "\n", "\r\n"))
		return []byte(b.String())
	}

	// Fixed boundary string with a random suffix: it must not appear in any part's content, and a
	// patient's record is arbitrary bytes.
	boundary := fmt.Sprintf("yourphr-%d-%s", time.Now().UnixNano(), randomToken())
	fmt.Fprintf(&b, "Content-Type: multipart/mixed; boundary=%q\r\n\r\n", boundary)

	fmt.Fprintf(&b, "--%s\r\n", boundary)
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n\r\n")
	b.WriteString(strings.ReplaceAll(m.Body, "\n", "\r\n"))
	b.WriteString("\r\n")

	for _, attachment := range m.Attachments {
		contentType := attachment.ContentType
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		fmt.Fprintf(&b, "--%s\r\n", boundary)
		fmt.Fprintf(&b, "Content-Type: %s\r\n", contentType)
		b.WriteString("Content-Transfer-Encoding: base64\r\n")
		fmt.Fprintf(&b, "Content-Disposition: attachment; filename=%q\r\n\r\n", attachment.Filename)
		b.WriteString(wrapBase64(attachment.Content))
		b.WriteString("\r\n")
	}

	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return []byte(b.String())
}

func wrapBase64(content []byte) string {
	encoded := base64.StdEncoding.EncodeToString(content)
	var b strings.Builder
	for len(encoded) > 76 {
		b.WriteString(encoded[:76])
		b.WriteString("\r\n")
		encoded = encoded[76:]
	}
	b.WriteString(encoded)
	return b.String()
}

func randomToken() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// A predictable boundary is still valid MIME; only collision resistance suffers.
		return "fallback"
	}
	return hex.EncodeToString(buf)
}
