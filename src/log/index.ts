/**
 * The application log (yourphr#602; the product's #435): one logger, a level, and a ring of the
 * most recent lines so the Logs page can show an operator what the process has been saying
 * without shell access. Every line still goes to stdout/stderr — the container log is the durable
 * one; the ring is the last N for the screen. Level changes are runtime-only, as in Go: a restart
 * returns to the configured level.
 */
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const VALID_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class AppLog {
  private level: LogLevel = 'info';
  private readonly lines: { level: LogLevel; line: string }[] = [];

  constructor(private readonly capacity = 500, private readonly sink: (level: LogLevel, line: string) => void = consoleSink) {}

  setLevel(level: string): LogLevel {
    const l = level.trim().toLowerCase();
    if (!VALID_LEVELS.includes(l as LogLevel)) throw new Error(`invalid log level ${JSON.stringify(level)}: one of ${VALID_LEVELS.join(', ')}`);
    this.level = l as LogLevel;
    return this.level;
  }

  currentLevel(): LogLevel {
    return this.level;
  }

  /**
   * One choke point, and redaction happens BEFORE the ring (yourphr#638). The buffered copy is
   * what `GET /api/secure/admin/logs` serves, so redacting only on the way to stdout would leave
   * the plaintext in memory behind an `admin-read` route — the surface that issue is about.
   * Inert until refreshRedactedSecrets() runs; see src/log/redact.ts for why it is pushed in.
   */
  log(level: LogLevel, message: string): void {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}`;
    this.lines.push({ level, line });
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    if (RANK[level] >= RANK[this.level]) this.sink(level, line);
  }

  debug(message: string): void { this.log('debug', message); }
  info(message: string): void { this.log('info', message); }
  warn(message: string): void { this.log('warn', message); }
  error(message: string): void { this.log('error', message); }

  /** Buffered lines at or above the running level, oldest first — what the page shows. */
  recent(): string[] {
    return this.lines.filter((l) => RANK[l.level] >= RANK[this.level]).map((l) => l.line);
  }
}

function consoleSink(level: LogLevel, line: string): void {
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** The process-wide logger; tests construct their own. */
export const appLog = new AppLog();
