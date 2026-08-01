// Package applog keeps the most recent server log lines in memory so the Admin Dashboard can always
// show them — no log.file, no restart (#170 follow-up). It installs a logrus hook that captures every
// emitted entry into a bounded ring buffer, and exposes runtime get/set of the log level. Level
// changes are runtime-only (they reset to the config default on restart by design).
//
// GET /admin/logs returns only lines at or above the running level (#435): raising the threshold
// both reduces future noise and filters the in-memory view of already-buffered lines.
package applog

import (
	"strings"
	"sync"

	"github.com/sirupsen/logrus"
)

// ringEntry is one buffered log line plus its severity (for display filtering).
type ringEntry struct {
	level logrus.Level
	line  string
}

// ringHook is a logrus.Hook that formats each entry and stores the last `size` lines.
type ringHook struct {
	mu   sync.Mutex
	buf  []ringEntry
	size int
	fmtr logrus.Formatter
}

func (h *ringHook) Levels() []logrus.Level { return logrus.AllLevels }

func (h *ringHook) Fire(e *logrus.Entry) error {
	b, err := h.fmtr.Format(e)
	if err != nil {
		return nil // never let logging break on a formatting error
	}
	line := strings.TrimRight(string(b), "\n")
	h.mu.Lock()
	h.buf = append(h.buf, ringEntry{level: e.Level, line: line})
	if len(h.buf) > h.size {
		h.buf = h.buf[len(h.buf)-h.size:]
	}
	h.mu.Unlock()
	return nil
}

// recent returns lines at or above minLevel (logrus: lower numeric = more severe; include if e.level <= minLevel).
// Pass logrus.TraceLevel to return everything in the buffer.
func (h *ringHook) recent(minLevel logrus.Level) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.buf))
	for _, e := range h.buf {
		// Same rule as logrus.Logger.IsLevelEnabled: entry is shown when entry.Level <= threshold.
		if e.level <= minLevel {
			out = append(out, e.line)
		}
	}
	return out
}

var (
	mu     sync.RWMutex
	hook   *ringHook
	target *logrus.Logger
)

// Install attaches the ring buffer to a logger and remembers it as the level-control target. Safe to
// call once at startup; a second call replaces the previous installation.
func Install(l *logrus.Logger, size int) {
	if l == nil || size <= 0 {
		return
	}
	h := &ringHook{
		size: size,
		fmtr: &logrus.TextFormatter{FullTimestamp: true, DisableColors: true},
	}
	l.AddHook(h)
	mu.Lock()
	hook, target = h, l
	mu.Unlock()
}

// Recent returns buffered log lines at or above the running logger level, oldest first.
// Empty if Install was never called. Matches what an admin expects after changing Log level (#435).
func Recent() []string {
	mu.RLock()
	h := hook
	t := target
	mu.RUnlock()
	if h == nil {
		return []string{}
	}
	min := logrus.TraceLevel // show everything if no target
	if t != nil {
		min = t.GetLevel()
	}
	return h.recent(min)
}

// RecentAll returns every buffered line regardless of level (tests / diagnostics).
func RecentAll() []string {
	mu.RLock()
	h := hook
	mu.RUnlock()
	if h == nil {
		return []string{}
	}
	return h.recent(logrus.TraceLevel)
}

// Level returns the installed logger's current level (e.g. "info"). "" if not installed.
func Level() string {
	mu.RLock()
	defer mu.RUnlock()
	if target == nil {
		return ""
	}
	return target.GetLevel().String()
}

// SetLevel changes the installed logger's level at runtime (case-insensitive: trace/debug/info/
// warn/error/...). Returns an error for an unknown level or if not installed.
func SetLevel(level string) error {
	lvl, err := logrus.ParseLevel(strings.ToLower(strings.TrimSpace(level)))
	if err != nil {
		return err
	}
	mu.RLock()
	t := target
	mu.RUnlock()
	if t == nil {
		return errNotInstalled
	}
	t.SetLevel(lvl)
	return nil
}

// ValidLevels are the selectable levels, lowest→highest severity excluded (most useful subset for the
// admin UI; ParseLevel still accepts panic/fatal too). Order is most verbose → least (trace…error).
var ValidLevels = []string{"trace", "debug", "info", "warn", "error"}

type appLogError string

func (e appLogError) Error() string { return string(e) }

const errNotInstalled appLogError = "log ring buffer not installed"
