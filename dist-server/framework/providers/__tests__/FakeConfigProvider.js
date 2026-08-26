/**
 * Configuration held in memory (yourphr#621): what a test uses instead of creating a temporary
 * directory on disk purely to have configuration. Before this, six unit-test files and two
 * harnesses did exactly that in tests that were not about configuration at all.
 */
import { BaseConfigProvider } from '../BaseConfigProvider.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/** The real shipped values, read once, so a fake is not a second opinion about what ships. */
const SHIPPED = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(process.cwd(), 'config', 'app-default-config.json'), 'utf8')))
    .filter(([key]) => !key.startsWith('_')));
export class FakeConfigProvider extends BaseConfigProvider {
    custom;
    defaults;
    unreadable;
    dataDir;
    name = 'fake';
    saves = 0;
    constructor(custom = {}, defaults = SHIPPED, unreadable, 
    /** The fast storage root path templates resolve against (yourphr#626). */
    dataDir = '/data') {
        super();
        this.custom = custom;
        this.defaults = defaults;
        this.unreadable = unreadable;
        this.dataDir = dataDir;
    }
    /** Same contract as the file provider: the root this instance was built over. */
    roots() {
        return { YOURPHR_FAST_STORAGE: this.dataDir, YOURPHR_SLOW_STORAGE: this.dataDir };
    }
    load() {
        return { defaults: { ...this.defaults }, custom: { ...this.custom }, ...(this.unreadable ? { customUnreadable: this.unreadable } : {}) };
    }
    saveCustom(custom) {
        this.saves++;
        this.custom = { ...custom };
    }
    /** What the "file" holds now — so a test can assert deltas were written, not the merged view. */
    written() {
        return { ...this.custom };
    }
    customLocation() {
        return '<in-memory>';
    }
}
//# sourceMappingURL=FakeConfigProvider.js.map