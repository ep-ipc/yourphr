import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteFavoritesProvider } from '../SqliteFavoritesProvider.js';

let favorites: SqliteFavoritesProvider;
const fav = (id: string, type = 'Practitioner') => ({ source_id: 'source-1', resource_type: type, resource_id: id });

beforeEach(async () => {
  favorites = new SqliteFavoritesProvider(new Database(':memory:'));
  await favorites.initialize();
});

describe('SqliteFavoritesProvider — the favorites table', () => {
  it('adds once, lists per owner and type in star order, removes, and clears an owner', async () => {
    await favorites.add('alice', fav('dr-b'), new Date('2026-01-02T00:00:00Z'));
    await favorites.add('alice', fav('dr-a'), new Date('2026-01-03T00:00:00Z'));
    await favorites.add('alice', fav('dr-b'), new Date('2026-01-04T00:00:00Z'));
    await favorites.add('alice', fav('p-1', 'Patient'), new Date('2026-01-01T00:00:00Z'));
    await favorites.add('bob', fav('dr-z'), new Date('2026-01-01T00:00:00Z'));
    expect((await favorites.list('alice', 'Practitioner')).map((f) => f.resource_id)).toEqual(['dr-b', 'dr-a']);
    expect(await favorites.remove('alice', fav('dr-b'))).toBe(true);
    expect(await favorites.remove('alice', fav('dr-b'))).toBe(false);
    expect(await favorites.removeAll('alice')).toBe(2);
    expect(await favorites.list('alice', 'Practitioner')).toEqual([]);
    expect(await favorites.list('bob', 'Practitioner')).toHaveLength(1);
  });
});
