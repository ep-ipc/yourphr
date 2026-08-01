package applog

import (
	"io"
	"strings"
	"testing"

	"github.com/sirupsen/logrus"
)

func newTestLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(io.Discard) // don't spam test output; the hook still fires
	l.SetLevel(logrus.InfoLevel)
	return l
}

// Installed logger's emitted entries land in the ring buffer (oldest first), and Level() reports it.
func TestRingBuffer_CapturesAndLevel(t *testing.T) {
	l := newTestLogger()
	Install(l, 100)

	l.Info("hello world")
	l.Warn("careful now")

	lines := Recent()
	if len(lines) < 2 {
		t.Fatalf("expected >=2 lines, got %d: %v", len(lines), lines)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "hello world") || !strings.Contains(joined, "careful now") {
		t.Errorf("ring buffer missing messages: %q", joined)
	}
	if Level() != "info" {
		t.Errorf("Level() = %q, want info", Level())
	}
}

// The buffer is bounded to its size (keeps the most recent).
func TestRingBuffer_Bounded(t *testing.T) {
	l := newTestLogger()
	Install(l, 5)
	for i := 0; i < 20; i++ {
		l.Infof("line-%d", i)
	}
	lines := Recent()
	if len(lines) != 5 {
		t.Fatalf("expected ring capped at 5, got %d", len(lines))
	}
	if !strings.Contains(lines[len(lines)-1], "line-19") {
		t.Errorf("newest line not retained: %v", lines)
	}
	if strings.Contains(strings.Join(lines, "\n"), "line-0") {
		t.Errorf("oldest line should have been evicted: %v", lines)
	}
}

// SetLevel changes the running level at runtime; debug lines appear only after switching to debug.
func TestSetLevel_RuntimeToggle(t *testing.T) {
	l := newTestLogger()
	Install(l, 100)

	l.Debug("invisible at info")
	if strings.Contains(strings.Join(Recent(), "\n"), "invisible at info") {
		t.Errorf("debug line should be filtered at info level")
	}

	if err := SetLevel("DEBUG"); err != nil {
		t.Fatalf("SetLevel(DEBUG): %v", err)
	}
	if Level() != "debug" {
		t.Errorf("Level() = %q, want debug", Level())
	}
	l.Debug("visible at debug")
	if !strings.Contains(strings.Join(Recent(), "\n"), "visible at debug") {
		t.Errorf("debug line should appear after switching to debug")
	}

	if err := SetLevel("nonsense"); err == nil {
		t.Errorf("SetLevel with an unknown level should error")
	}
}

// Raising the level filters already-buffered lower-severity lines from Recent() (#435).
func TestRecent_FiltersByRunningLevel(t *testing.T) {
	l := newTestLogger()
	l.SetLevel(logrus.DebugLevel)
	Install(l, 100)

	l.Debug("dbg-line")
	l.Info("info-line")
	l.Error("err-line")

	// At debug: all three visible.
	joined := strings.Join(Recent(), "\n")
	for _, want := range []string{"dbg-line", "info-line", "err-line"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("at debug, missing %q in %q", want, joined)
		}
	}

	// Raise to error: only error+ remains in the view; buffer still holds the rest.
	if err := SetLevel("error"); err != nil {
		t.Fatalf("SetLevel(error): %v", err)
	}
	joined = strings.Join(Recent(), "\n")
	if !strings.Contains(joined, "err-line") {
		t.Errorf("error line should remain: %q", joined)
	}
	if strings.Contains(joined, "dbg-line") || strings.Contains(joined, "info-line") {
		t.Errorf("debug/info should be filtered from view at error level: %q", joined)
	}
	all := strings.Join(RecentAll(), "\n")
	if !strings.Contains(all, "dbg-line") || !strings.Contains(all, "info-line") {
		t.Errorf("RecentAll should still hold lower-severity lines: %q", all)
	}
}
