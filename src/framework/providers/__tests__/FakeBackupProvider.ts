/** An in-memory backup store for the manager specs: artifacts by destination, a scriptable writability. */
import { BaseBackupProvider, type BackupArtifact } from '../BaseBackupProvider.js';

export class FakeBackupProvider extends BaseBackupProvider {
  readonly name = 'fake';
  initialized = false;
  prepared: string[] = [];
  artifacts = new Map<string, BackupArtifact[]>();
  writable = true;
  async initialize(): Promise<void> { this.initialized = true; }
  async ensure(destination: string): Promise<void> {
    if (!this.writable) throw new Error(`cannot create ${destination}: read-only file system`);
    this.prepared.push(destination);
  }
  /** What the exporter "wrote" — the spec adds artifacts as the fake exporter reports them. */
  add(destination: string, name: string, sizeBytes = 10): void {
    const list = this.artifacts.get(destination) ?? [];
    list.unshift({ name, sizeBytes, modified: `2026-01-01T00:00:00.000Z` });
    this.artifacts.set(destination, list);
  }
  async list(destination: string): Promise<BackupArtifact[]> { return [...(this.artifacts.get(destination) ?? [])]; }
  async resolve(destination: string, name: string): Promise<string | undefined> {
    return (this.artifacts.get(destination) ?? []).some((a) => a.name === name) ? `${destination}/${name}` : undefined;
  }
  async prune(destination: string, keep: number): Promise<string[]> {
    if (keep <= 0) return [];
    const list = this.artifacts.get(destination) ?? [];
    const pruned = list.splice(keep).map((a) => a.name);
    return pruned;
  }
  async testDestination(destination: string): Promise<{ destination: string; writable: boolean; error?: string }> {
    return this.writable ? { destination, writable: true } : { destination, writable: false, error: 'read-only file system' };
  }
  async browse(path: string): Promise<{ path: string; parent: string; dirs: string[] }> {
    if (path === '/nope') throw new Error('cannot read "/nope": not a directory');
    return { path, parent: path === '/' ? '' : '/', dirs: ['a', 'b'] };
  }
}
