/** An in-memory catalog provider for the manager specs; the secret is held beside the entry, never on it. */
import { BaseCatalogProvider, type CatalogEntry, type CatalogFields } from '../BaseCatalogProvider.js';

export class FakeCatalogProvider extends BaseCatalogProvider {
  rows = new Map<number, CatalogFields>();
  initialized = false;
  private nextId = 1;
  async initialize(): Promise<void> { this.initialized = true; }
  private entry(id: number, f: CatalogFields): CatalogEntry {
    const { clientSecret, ...rest } = f;
    return { id, ...rest, hasClientSecret: clientSecret !== '' };
  }
  async create(fields: CatalogFields): Promise<CatalogEntry> {
    if ([...this.rows.values()].some((r) => r.display === fields.display)) throw new Error('UNIQUE constraint failed: provider_catalog.display');
    const id = this.nextId++;
    this.rows.set(id, { ...fields });
    return this.entry(id, fields);
  }
  async update(id: number, fields: CatalogFields): Promise<CatalogEntry | undefined> {
    if (!this.rows.has(id)) return undefined;
    this.rows.set(id, { ...fields });
    return this.entry(id, fields);
  }
  async remove(id: number): Promise<boolean> { return this.rows.delete(id); }
  async byId(id: number): Promise<CatalogEntry | undefined> { const r = this.rows.get(id); return r ? this.entry(id, r) : undefined; }
  async byDisplay(display: string): Promise<CatalogEntry | undefined> {
    for (const [id, r] of this.rows) if (r.display === display) return this.entry(id, r);
    return undefined;
  }
  async list(): Promise<CatalogEntry[]> { return [...this.rows].map(([id, r]) => this.entry(id, r)).sort((a, b) => a.display.localeCompare(b.display)); }
  async clientSecretFor(id: number): Promise<string> { return this.rows.get(id)?.clientSecret ?? ''; }
}
