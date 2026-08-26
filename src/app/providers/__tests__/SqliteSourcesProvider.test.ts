import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteSourcesProvider } from '../SqliteSourcesProvider.js';

let db: InstanceType<typeof Database>;
let provider: SqliteSourcesProvider;
const src = (userId: string, over: Record<string, unknown> = {}) => ({
  userId, display: 'Clinic', fhirBaseUrl: 'https://fhir.example.org/r4', tokenUrl: 'https://fhir.example.org/token', clientId: 'cid', patient: 'p1',
  resourceTypes: ['Condition', 'Observation'], accessToken: 'tok', refreshToken: 'ref', expiresAt: 500, ...over,
});

beforeEach(async () => {
  db = new Database(':memory:');
  provider = new SqliteSourcesProvider(db);
  await provider.initialize();
});

describe('SqliteSourcesProvider — the connected_sources and dynamic_clients tables', () => {
  it('adds and reads back a source with the types joined and the unknowns empty', async () => {
    const added = await provider.add(src('alice'));
    expect(added).toMatchObject({ id: 1, userId: 'alice', resourceTypes: ['Condition', 'Observation'], lastSyncAt: 0, platformType: '', environment: '' });
    expect(await provider.byId(1)).toEqual(added);
    expect(await provider.byId(2)).toBeUndefined();
    expect(await provider.count()).toBe(1);
  });

  it('lists in id order and carries platform_type + environment when given', async () => {
    await provider.add(src('alice'));
    await provider.add(src('bob', { platformType: 'ehr', environment: 'production' }));
    expect((await provider.list()).map((s) => [s.id, s.userId, s.platformType, s.environment])).toEqual([[1, 'alice', '', ''], [2, 'bob', 'ehr', 'production']]);
  });

  it('updates tokens, the token endpoint, the sync stamp; clears tokens on disconnect', async () => {
    await provider.add(src('alice', { tokenUrl: '' }));
    await provider.updateTokenUrl(1, 'https://idp.example.org/token');
    await provider.updateTokens(1, 'a2', 'r2', 900);
    await provider.markSynced(1, 123);
    expect(await provider.byId(1)).toMatchObject({ tokenUrl: 'https://idp.example.org/token', accessToken: 'a2', refreshToken: 'r2', expiresAt: 900, lastSyncAt: 123 });
    await provider.clearTokens(1);
    expect(await provider.byId(1)).toMatchObject({ accessToken: '', refreshToken: '', expiresAt: 0, lastSyncAt: 123 });
  });

  it('a dynamic client is one per source, replaced on re-registration, removed with the source', async () => {
    await provider.add(src('alice'));
    const dyn = { clientId: 'dyn-1', clientSecret: 's', registrationAccessToken: 'rat', registrationClientUri: 'https://idp.example.org/reg/1' };
    await provider.saveDynamicClient(1, dyn);
    expect(await provider.dynamicClientFor(1)).toEqual(dyn);
    await provider.saveDynamicClient(1, { ...dyn, clientId: 'dyn-2' });
    expect((await provider.dynamicClientFor(1))?.clientId).toBe('dyn-2');
    expect(await provider.dynamicClientFor(2)).toBeUndefined();
    await provider.remove(1);
    expect(await provider.byId(1)).toBeUndefined();
    expect(await provider.dynamicClientFor(1)).toBeUndefined();
  });
});
