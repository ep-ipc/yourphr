export const VALID_LEVELS = ['debug', 'info', 'warn', 'error'];
const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
export class AppLog {
    capacity;
    sink;
    level = 'info';
    lines = [];
    constructor(capacity = 500, sink = consoleSink) {
        this.capacity = capacity;
        this.sink = sink;
    }
    setLevel(level) {
        const l = level.trim().toLowerCase();
        if (!VALID_LEVELS.includes(l))
            throw new Error(`invalid log level ${JSON.stringify(level)}: one of ${VALID_LEVELS.join(', ')}`);
        this.level = l;
        return this.level;
    }
    currentLevel() {
        return this.level;
    }
    log(level, message) {
        const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
        this.lines.push({ level, line });
        if (this.lines.length > this.capacity)
            this.lines.splice(0, this.lines.length - this.capacity);
        if (RANK[level] >= RANK[this.level])
            this.sink(level, line);
    }
    debug(message) { this.log('debug', message); }
    info(message) { this.log('info', message); }
    warn(message) { this.log('warn', message); }
    error(message) { this.log('error', message); }
    /** Buffered lines at or above the running level, oldest first — what the page shows. */
    recent() {
        return this.lines.filter((l) => RANK[l.level] >= RANK[this.level]).map((l) => l.line);
    }
}
function consoleSink(level, line) {
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.log(line);
}
/** The process-wide logger; tests construct their own. */
export const appLog = new AppLog();
//# sourceMappingURL=index.js.map