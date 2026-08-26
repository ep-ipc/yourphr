/** The SMART on FHIR source client (yourphr#612, #613) over src/smart (authorize, exchange, refresh) and src/sync (paging). */
import { randomUUID } from 'node:crypto';
import { SmartClient, generateVerifier } from '../../smart/index.js';
import { syncFrom } from '../../sync/index.js';
import { BaseSourceClientProvider, SourceClientError } from './BaseSourceClientProvider.js';
export class SmartSourceClientProvider extends BaseSourceClientProvider {
    options;
    name = 'smart';
    constructor(options = {}) {
        super();
        this.options = options;
    }
    clientFor(app, redirectUri) {
        return new SmartClient({ fhirBaseUrl: app.fhirBaseUrl, clientId: app.clientId, clientSecret: app.clientSecret || undefined, redirectUri, scopes: app.scopes, allowInternal: this.options.allowInternal });
    }
    async discover(client, app) {
        let endpoints;
        try {
            endpoints = await client.discover();
        }
        catch (err) {
            throw new SourceClientError('discovery', `SMART discovery failed: ${err.message}`);
        }
        return app.authorizeUrlOverride ? { ...endpoints, authorization: app.authorizeUrlOverride } : endpoints;
    }
    async beginAuthorization(app, redirectUri) {
        const client = this.clientFor(app, redirectUri);
        const endpoints = await this.discover(client, app);
        const state = randomUUID();
        const codeVerifier = generateVerifier();
        return { authorizeUrl: client.authorizeUrl(endpoints, state, codeVerifier), state, codeVerifier };
    }
    async completeAuthorization(app, redirectUri, code, codeVerifier) {
        const client = this.clientFor(app, redirectUri);
        const endpoints = await this.discover(client, app);
        try {
            const token = await client.exchangeCode(endpoints, code, codeVerifier);
            return {
                tokenUrl: endpoints.token,
                accessToken: token.accessToken,
                refreshToken: token.refreshToken ?? '',
                expiresAt: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : 0,
                patient: (token.patient ?? '').trim(),
            };
        }
        catch (err) {
            throw new SourceClientError('exchange', `token exchange failed: ${err.message}`);
        }
    }
    async refresh(source, nowSeconds) {
        const client = new SmartClient({ fhirBaseUrl: source.fhirBaseUrl, clientId: source.clientId, redirectUri: 'unused-for-refresh', scopes: [], allowInternal: this.options.allowInternal });
        // A migrated source arrives without a token endpoint (Go re-discovered every time, yourphr#584): discover once.
        const tokenUrl = source.tokenUrl === '' ? (await client.discover()).token : source.tokenUrl;
        const endpoints = { authorization: 'unused-for-refresh', token: tokenUrl };
        const token = await client.refresh(endpoints, source.refreshToken);
        return {
            accessToken: token.accessToken,
            refreshToken: token.refreshToken ?? source.refreshToken, // some providers rotate, some repeat — keep whichever is newest
            expiresAt: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : nowSeconds + 3600,
            tokenUrl,
        };
    }
    async fetchPages(source, resourceType, accessToken, writer, maxPages) {
        const r = await syncFrom(`${source.fhirBaseUrl}/${resourceType}?patient=${source.patient}&_count=100`, { writer, accessToken, maxPages, allowInternal: this.options.allowInternal });
        return { received: r.received, created: r.created, updated: r.updated };
    }
}
//# sourceMappingURL=SmartSourceClientProvider.js.map