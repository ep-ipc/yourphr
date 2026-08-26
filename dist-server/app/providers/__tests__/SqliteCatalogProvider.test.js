import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { SqliteCatalogProvider } from '../SqliteCatalogProvider.js';
const fields = (over = {}) => ({
    display: 'Clinic', environment: 'production', fhirBaseUrl: 'https://fhir.example.org/r4', scopes: 'patient/*.read', clientId: 'cid', clientSecret: 's3cret',
    enabled: true, authorizeUrlOverride: '', platformType: 'ehr', brandLogoUrl: '', consentPolicy: 'required', preConnectProfile: 'auto', ...over,
});
let provider;
beforeEach(async () => {
    provider = new SqliteCatalogProvider(new Database(':memory:'));
    await provider.initialize();
});
describe('SqliteCatalogProvider — the provider_catalog table', () => {
    it('creates and reads back with hasClientSecret in place of the secret', async () => {
        const e = await provider.create(fields());
        expect(e).toMatchObject({ id: 1, display: 'Clinic', hasClientSecret: true, enabled: true, consentPolicy: 'required' });
        expect(e).not.toHaveProperty('clientSecret');
        expect(await provider.byId(1)).toEqual(e);
        expect(await provider.byDisplay('Clinic')).toEqual(e);
        expect(await provider.byDisplay('Nope')).toBeUndefined();
        expect(await provider.clientSecretFor(1)).toBe('s3cret');
        expect(await provider.clientSecretFor(2)).toBe('');
    });
    it('display is unique; list is by display', async () => {
        await provider.create(fields({ display: 'Zed' }));
        await provider.create(fields({ display: 'Alpha', clientSecret: '' }));
        await expect(provider.create(fields({ display: 'Zed' }))).rejects.toThrow(/UNIQUE/);
        expect((await provider.list()).map((e) => [e.display, e.hasClientSecret])).toEqual([['Alpha', false], ['Zed', true]]);
    });
    it('update replaces the row, remove reports whether there was one', async () => {
        await provider.create(fields());
        expect(await provider.update(1, fields({ scopes: 'x', clientSecret: '', enabled: false }))).toMatchObject({ scopes: 'x', hasClientSecret: false, enabled: false });
        expect(await provider.update(9, fields())).toBeUndefined();
        expect(await provider.remove(1)).toBe(true);
        expect(await provider.remove(1)).toBe(false);
    });
});
//# sourceMappingURL=SqliteCatalogProvider.test.js.map