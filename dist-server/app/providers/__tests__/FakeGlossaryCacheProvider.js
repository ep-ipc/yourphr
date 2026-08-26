/** The glossary cache in memory — what a manager test uses instead of reaching for the driver. */
import { BaseGlossaryCacheProvider } from '../BaseGlossaryProvider.js';
export class FakeGlossaryCacheProvider extends BaseGlossaryCacheProvider {
    rows = new Map();
    key(code, oid) { return `${code}|${oid}`; }
    get(code, oid) { return this.rows.get(this.key(code, oid)); }
    put(code, oid, entry) { this.rows.set(this.key(code, oid), entry); }
    count() { return this.rows.size; }
}
//# sourceMappingURL=FakeGlossaryCacheProvider.js.map