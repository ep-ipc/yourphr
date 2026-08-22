/** The SMART on FHIR source client (yourphr#612) over src/smart (refresh) and src/sync (paging). */
import { SmartClient, type Endpoints } from '../../smart/index.js';
import { syncFrom } from '../../sync/index.js';
import { BaseSourceClientProvider, type FetchReport, type RefreshedTokens } from './BaseSourceClientProvider.js';
import type { ConnectedSource } from './BaseSourcesProvider.js';
import type { RecordsWriter } from './BaseRecordsProvider.js';

export class SmartSourceClientProvider extends BaseSourceClientProvider {
  readonly name = 'smart';
  constructor(private readonly options: { allowInternal?: boolean } = {}) { super(); }

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

  async fetch(source: ConnectedSource, resourceType: string, accessToken: string, writer: RecordsWriter, maxPages: number): Promise<FetchReport> {
    const r = await syncFrom(`${source.fhirBaseUrl}/${resourceType}?patient=${source.patient}&_count=100`, { writer, accessToken, maxPages, allowInternal: this.options.allowInternal });
    return { received: r.received, created: r.created, updated: r.updated };
  }
}
