/** The SMART on FHIR source client (yourphr#612, #613) over src/smart (authorize, exchange, refresh) and src/sync (paging). */
import { randomUUID } from 'node:crypto';
import { SmartClient, generateVerifier, type Endpoints } from '../../smart/index.js';
import { syncFrom } from '../../sync/index.js';
import { BaseSourceClientProvider, SourceClientError, type AuthorizationResult, type AuthorizationStart, type FetchReport, type RefreshedTokens, type SmartApp } from './BaseSourceClientProvider.js';
import type { ConnectedSource } from './BaseSourcesProvider.js';
import type { RecordsWriter } from './BaseRecordsProvider.js';

export class SmartSourceClientProvider extends BaseSourceClientProvider {
  readonly name = 'smart';
  constructor(private readonly options: { allowInternal?: boolean } = {}) { super(); }

  private clientFor(app: SmartApp, redirectUri: string): SmartClient {
    return new SmartClient({ fhirBaseUrl: app.fhirBaseUrl, clientId: app.clientId, clientSecret: app.clientSecret || undefined, redirectUri, scopes: app.scopes, allowInternal: this.options.allowInternal });
  }

  private async discover(client: SmartClient, app: SmartApp): Promise<Endpoints> {
    let endpoints: Endpoints;
    try {
      endpoints = await client.discover();
    } catch (err) {
      throw new SourceClientError('discovery', `SMART discovery failed: ${(err as Error).message}`);
    }
    return app.authorizeUrlOverride ? { ...endpoints, authorization: app.authorizeUrlOverride } : endpoints;
  }

  async beginAuthorization(app: SmartApp, redirectUri: string): Promise<AuthorizationStart> {
    const client = this.clientFor(app, redirectUri);
    const endpoints = await this.discover(client, app);
    const state = randomUUID();
    const codeVerifier = generateVerifier();
    return { authorizeUrl: client.authorizeUrl(endpoints, state, codeVerifier), state, codeVerifier };
  }

  async completeAuthorization(app: SmartApp, redirectUri: string, code: string, codeVerifier: string): Promise<AuthorizationResult> {
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
    } catch (err) {
      throw new SourceClientError('exchange', `token exchange failed: ${(err as Error).message}`);
    }
  }

  async refresh(source: ConnectedSource, nowSeconds: number): Promise<RefreshedTokens> {
    const client = new SmartClient({ fhirBaseUrl: source.fhirBaseUrl, clientId: source.clientId, redirectUri: 'unused-for-refresh', scopes: [], allowInternal: this.options.allowInternal });
    // A migrated source arrives without a token endpoint (Go re-discovered every time, yourphr#584): discover once.
    const tokenUrl = source.tokenUrl === '' ? (await client.discover()).token : source.tokenUrl;
    const endpoints: Endpoints = { authorization: 'unused-for-refresh', token: tokenUrl };
    const token = await client.refresh(endpoints, source.refreshToken);
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? source.refreshToken, // some providers rotate, some repeat — keep whichever is newest
      expiresAt: token.expiresAt ? Math.floor(token.expiresAt.getTime() / 1000) : nowSeconds + 3600,
      tokenUrl,
    };
  }

  async fetchPages(source: ConnectedSource, resourceType: string, accessToken: string, writer: RecordsWriter, maxPages: number): Promise<FetchReport> {
    const r = await syncFrom(`${source.fhirBaseUrl}/${resourceType}?patient=${source.patient}&_count=100`, { writer, accessToken, maxPages, allowInternal: this.options.allowInternal });
    return { received: r.received, created: r.created, updated: r.updated };
  }
}
