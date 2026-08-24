/** The glossary cache in memory — what a manager test uses instead of reaching for the driver. */
import { BaseGlossaryCacheProvider, type GlossaryEntry } from '../BaseGlossaryProvider.js';

export class FakeGlossaryCacheProvider extends BaseGlossaryCacheProvider {
  readonly rows = new Map<string, GlossaryEntry>();
  private key(code: string, oid: string): string { return `${code}|${oid}`; }
  override get(code: string, oid: string): GlossaryEntry | undefined { return this.rows.get(this.key(code, oid)); }
  override put(code: string, oid: string, entry: GlossaryEntry): void { this.rows.set(this.key(code, oid), entry); }
  override count(): number { return this.rows.size; }
}
