package mail

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"net"
	"strings"
	"testing"

	"github.com/fastenhealth/fasten-onprem/backend/pkg/config"
	"github.com/sirupsen/logrus"
	"github.com/sirupsen/logrus/hooks/test"
	"github.com/stretchr/testify/require"
)

func testConfig(t *testing.T, values map[string]interface{}) config.Interface {
	t.Helper()
	c, err := config.Create()
	require.NoError(t, err)
	for k, v := range values {
		c.SetDefault(k, v)
	}
	return c
}

// The property that makes an unconfigured instance usable rather than broken: nothing configured
// means the message is logged, NOT an error the caller has to handle (#536).
func TestNew_DefaultsToConsole(t *testing.T) {
	sender, err := New(testConfig(t, nil), nil)

	require.NoError(t, err)
	require.Contains(t, sender.Describe(), "console")
}

func TestConsoleSender_LogsInsteadOfSending(t *testing.T) {
	logger, hook := test.NewNullLogger()
	sender, err := New(testConfig(t, nil), logrus.NewEntry(logger))
	require.NoError(t, err)

	require.NoError(t, sender.Send(Message{To: []string{"someone@example.org"}, Subject: "Test", Body: "hello"}))

	require.Len(t, hook.Entries, 1)
	require.Contains(t, hook.LastEntry().Message, "someone@example.org")
	require.Contains(t, hook.LastEntry().Message, "Test")
}

// A body will eventually carry a password-reset link or a patient's own record. Neither belongs in
// a log file that gets attached to a bug report.
func TestConsoleSender_DoesNotLogTheBody(t *testing.T) {
	logger, hook := test.NewNullLogger()
	sender, err := New(testConfig(t, nil), logrus.NewEntry(logger))
	require.NoError(t, err)

	require.NoError(t, sender.Send(Message{
		To:      []string{"someone@example.org"},
		Subject: "Your records",
		Body:    "SECRET-RESET-TOKEN-abc123",
	}))

	require.NotContains(t, hook.LastEntry().Message, "SECRET-RESET-TOKEN-abc123")
}

// Enabled but still on the console provider is a legitimate state — an operator turning mail on
// before configuring a relay should not meet an error.
func TestNew_EnabledWithConsoleProviderIsFine(t *testing.T) {
	sender, err := New(testConfig(t, map[string]interface{}{KeyEnabled: true, KeyProvider: "console"}), nil)

	require.NoError(t, err)
	require.Contains(t, sender.Describe(), "console")
}

// Disabled wins over any provider setting: the public demo must not send, whatever else is set.
func TestNew_DisabledOverridesSMTP(t *testing.T) {
	sender, err := New(testConfig(t, map[string]interface{}{
		KeyEnabled:  false,
		KeyProvider: "smtp",
		KeySMTPHost: "smtp.example.com",
		KeyFrom:     "phr@example.org",
	}), nil)

	require.NoError(t, err)
	require.Contains(t, sender.Describe(), "console")
}

// "Not configured" is silence; "configured wrongly" is an error naming the setting to fix.
func TestNew_SMTPWithoutHostIsAnError(t *testing.T) {
	_, err := New(testConfig(t, map[string]interface{}{KeyEnabled: true, KeyProvider: "smtp"}), nil)

	require.Error(t, err)
	require.Contains(t, err.Error(), KeySMTPHost)
}

func TestNew_SMTPWithoutFromIsAnError(t *testing.T) {
	_, err := New(testConfig(t, map[string]interface{}{
		KeyEnabled:  true,
		KeyProvider: "smtp",
		KeySMTPHost: "smtp.example.com",
	}), nil)

	require.Error(t, err)
	require.Contains(t, err.Error(), KeyFrom)
}

func TestNew_UnknownProviderIsAnError(t *testing.T) {
	_, err := New(testConfig(t, map[string]interface{}{KeyEnabled: true, KeyProvider: "carrier-pigeon"}), nil)

	require.Error(t, err)
	require.Contains(t, err.Error(), "carrier-pigeon")
}

func TestMessage_ValidationRejectsIncompleteMessages(t *testing.T) {
	sender, err := New(testConfig(t, nil), nil)
	require.NoError(t, err)

	require.ErrorContains(t, sender.Send(Message{Subject: "s"}), "no recipient")
	require.ErrorContains(t, sender.Send(Message{To: []string{"a@b.c"}}), "no subject")
	require.ErrorContains(t, sender.Send(Message{To: []string{"  "}, Subject: "s"}), "empty recipient")
}

// Some relays reject bare LF, so the rendered message must use CRLF throughout — including inside a
// multi-line body, which is the easy half to forget.
func TestMessage_RendersCRLF(t *testing.T) {
	rendered := string(Message{
		To:      []string{"a@example.org", "b@example.org"},
		Subject: "Your records",
		Body:    "line one\nline two",
	}.render("phr@example.org"))

	require.Contains(t, rendered, "From: phr@example.org\r\n")
	require.Contains(t, rendered, "To: a@example.org, b@example.org\r\n")
	require.Contains(t, rendered, "Subject: Your records\r\n")
	require.Contains(t, rendered, "line one\r\nline two")
	require.NotContains(t, strings.ReplaceAll(rendered, "\r\n", ""), "\n")
}

// End to end against a real socket speaking SMTP, so the conversation itself is exercised rather
// than mocked: a fake that returns "250 OK" to anything would pass while the client sent nonsense.
func TestSMTPSender_DeliversThroughARelay(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer listener.Close()

	received := make(chan string, 1)
	go serveOneSMTPSession(listener, received)

	host, port, err := net.SplitHostPort(listener.Addr().String())
	require.NoError(t, err)

	sender, err := New(testConfig(t, map[string]interface{}{
		KeyEnabled:  true,
		KeyProvider: "smtp",
		KeySMTPHost: host,
		KeySMTPPort: port,
		KeyFrom:     "phr@example.org",
	}), nil)
	require.NoError(t, err)

	require.NoError(t, sender.Send(Message{
		To:      []string{"doctor@example.org"},
		Subject: "Your records",
		Body:    "attached",
	}))

	conversation := <-received
	require.Contains(t, conversation, "MAIL FROM:<phr@example.org>")
	require.Contains(t, conversation, "RCPT TO:<doctor@example.org>")
	require.Contains(t, conversation, "Subject: Your records")
}

func TestSMTPSender_UnreachableRelayNamesTheAddress(t *testing.T) {
	// Port 1 is reserved and nothing listens there.
	sender, err := New(testConfig(t, map[string]interface{}{
		KeyEnabled:  true,
		KeyProvider: "smtp",
		KeySMTPHost: "127.0.0.1",
		KeySMTPPort: 1,
		KeyFrom:     "phr@example.org",
	}), nil)
	require.NoError(t, err)

	err = sender.Send(Message{To: []string{"a@example.org"}, Subject: "s", Body: "b"})

	require.ErrorContains(t, err, "could not reach the mail relay at 127.0.0.1:1")
}

// serveOneSMTPSession speaks just enough SMTP for one message, recording what the client said.
func serveOneSMTPSession(listener net.Listener, received chan<- string) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	defer conn.Close()

	var log strings.Builder
	reader := bufio.NewReader(conn)
	fmt.Fprint(conn, "220 test.local ESMTP\r\n")

	inData := false
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		log.WriteString(line)
		trimmed := strings.TrimSpace(line)

		switch {
		case inData:
			if trimmed == "." {
				inData = false
				fmt.Fprint(conn, "250 OK\r\n")
			}
		case strings.HasPrefix(trimmed, "EHLO"), strings.HasPrefix(trimmed, "HELO"):
			// No STARTTLS advertised, matching a local test relay like Mailhog.
			fmt.Fprint(conn, "250-test.local\r\n250 SIZE 10240000\r\n")
		case strings.HasPrefix(trimmed, "DATA"):
			inData = true
			fmt.Fprint(conn, "354 send it\r\n")
		case strings.HasPrefix(trimmed, "QUIT"):
			fmt.Fprint(conn, "221 bye\r\n")
			received <- log.String()
			return
		default:
			fmt.Fprint(conn, "250 OK\r\n")
		}
	}
	received <- log.String()
}

// A patient sending their record is sending a FILE. Plain-text-only would have meant the feature
// silently mailed an empty message (#524).
func TestMessage_RendersAttachmentsAsMultipart(t *testing.T) {
	rendered := string(Message{
		To:      []string{"doctor@example.org"},
		Subject: "My records",
		Body:    "Attached are my records.",
		Attachments: []Attachment{{
			Filename:    "yourphr-report.html",
			ContentType: "text/html",
			Content:     []byte("<html><body>records</body></html>"),
		}},
	}.render("phr@example.org"))

	require.Contains(t, rendered, "Content-Type: multipart/mixed; boundary=")
	require.Contains(t, rendered, "Content-Type: text/html")
	require.Contains(t, rendered, `Content-Disposition: attachment; filename="yourphr-report.html"`)
	require.Contains(t, rendered, "Content-Transfer-Encoding: base64")
	require.Contains(t, rendered, base64.StdEncoding.EncodeToString([]byte("<html><body>records</body></html>")))
	require.Contains(t, rendered, "Attached are my records.")
}

// RFC 2045 caps base64 lines at 76 characters, and some relays reject longer ones. A whole medical
// record is far past that, so this is the normal case rather than an edge case.
func TestMessage_WrapsBase64At76Characters(t *testing.T) {
	rendered := string(Message{
		To:          []string{"a@example.org"},
		Subject:     "s",
		Attachments: []Attachment{{Filename: "big.bin", Content: make([]byte, 4096)}},
	}.render("phr@example.org"))

	for _, line := range strings.Split(rendered, "\r\n") {
		require.LessOrEqual(t, len(line), 998, "no line may exceed the SMTP limit")
	}
	// The encoded payload itself must be wrapped, not merely under the hard limit.
	require.Contains(t, rendered, strings.Repeat("A", 76))
}

func TestMessage_DefaultsAnAttachmentContentType(t *testing.T) {
	rendered := string(Message{
		To:          []string{"a@example.org"},
		Subject:     "s",
		Attachments: []Attachment{{Filename: "unknown.bin", Content: []byte("x")}},
	}.render("phr@example.org"))

	require.Contains(t, rendered, "Content-Type: application/octet-stream")
}

// Without attachments the message stays a simple text/plain email rather than a one-part multipart.
func TestMessage_StaysPlainWithoutAttachments(t *testing.T) {
	rendered := string(Message{To: []string{"a@example.org"}, Subject: "s", Body: "b"}.render("phr@example.org"))

	require.Contains(t, rendered, "Content-Type: text/plain; charset=UTF-8")
	require.NotContains(t, rendered, "multipart/mixed")
}
