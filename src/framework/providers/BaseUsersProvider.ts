/**
 * User storage (yourphr#611): the accounts table behind the Users manager. A capability an adopter
 * would plausibly swap (ngdpbase has FileUserProvider); the manager decides, the provider stores.
 * Password hashes live here and leave only to the auth provider that verifies them.
 */
export type Role = 'admin' | 'user';

/** Anything that is not exactly 'admin' is a user — a typo in a role is never a privilege. */
export function normaliseRole(role: unknown): Role {
  return role === 'admin' ? 'admin' : 'user';
}

export interface UserRecord {
  username: string;
  passwordHash: string;
  /** The revocation counter (yourphr#508): a session below it is dead. */
  tokenGeneration: number;
  role: Role;
  createdAt: string;
}

export abstract class BaseUsersProvider {
  abstract initialize(): Promise<void>;
  abstract create(record: Omit<UserRecord, 'createdAt'> & { createdAt?: string }): Promise<void>;
  abstract get(username: string): Promise<UserRecord | undefined>;
  abstract list(): Promise<UserRecord[]>;
  abstract count(): Promise<number>;
  /** A new hash; bumping the generation ends every session (a password CHANGE), not bumping keeps them (an upgrade-on-login). */
  abstract setPasswordHash(username: string, hash: string, bumpGeneration: boolean): Promise<boolean>;
  abstract bumpGeneration(username: string): Promise<void>;
  abstract delete(username: string): Promise<boolean>;
}
