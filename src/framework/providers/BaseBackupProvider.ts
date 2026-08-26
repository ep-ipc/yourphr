/**
 * Backup storage (yourphr#615): where backup artifacts live — listing, pruning, proving a
 * destination, browsing folders. OPTIONAL (decision Q6): the Null provider keeps the instance
 * serving and makes every backup action refuse with a reason. The encrypted export itself is not
 * here — the component holding the key is the only one that can export correctly, so it stays
 * below the PHI-storage door; this provider only stores and names what that export wrote.
 */
export interface BackupArtifact { name: string; sizeBytes: number; modified: string }

export abstract class BaseBackupProvider {
  abstract readonly name: string;
  abstract initialize(): Promise<void>;
  /** Make the destination exist and be writable before an export is attempted. */
  abstract ensure(destination: string): Promise<void>;
  /** Every artifact in the destination, newest first. */
  abstract list(destination: string): Promise<BackupArtifact[]>;
  /** The path of a named artifact, or undefined when the name is not one of ours or it is absent. */
  abstract resolve(destination: string, name: string): Promise<string | undefined>;
  /** Keep the newest `keep`; the names removed. 0 keeps everything. */
  abstract prune(destination: string, keep: number): Promise<string[]>;
  /** Prove a destination before a schedule relies on it (the product's #468): a write, then its removal. */
  abstract testDestination(destination: string): Promise<{ destination: string; writable: boolean; error?: string }>;
  /** One level of folders, sorted, parent when there is one. Absolute paths only. Throws when not a directory. */
  abstract browse(path: string): Promise<{ path: string; parent: string; dirs: string[] }>;
}

export class NullBackupProvider extends BaseBackupProvider {
  readonly name = 'null';
  private refuse(): never {
    throw new Error('no backup storage is configured (backup.storage.provider = null): backups cannot be written, listed or restored');
  }
  async initialize(): Promise<void> { /* nothing to open */ }
  async ensure(): Promise<void> { this.refuse(); }
  async list(): Promise<BackupArtifact[]> { return []; }
  async resolve(): Promise<string | undefined> { return undefined; }
  async prune(): Promise<string[]> { return []; }
  async testDestination(destination: string): Promise<{ destination: string; writable: boolean; error?: string }> {
    return { destination, writable: false, error: 'no backup storage is configured (backup.storage.provider = null)' };
  }
  async browse(): Promise<{ path: string; parent: string; dirs: string[] }> { this.refuse(); }
}
