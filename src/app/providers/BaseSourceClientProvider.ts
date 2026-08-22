/**
 * The source client (yourphr#612): how this instance talks to a connected provider — token
 * refresh and record fetching. OPTIONAL (decision Q6): an instance with no connected sources
 * never loads the URL-fetching path; the Null provider refuses to sync and says why.
 */
import type { RecordsWriter } from './BaseRecordsProvider.js';
import type { ConnectedSource } from './BaseSourcesProvider.js';

export interface RefreshedTokens { accessToken: string; refreshToken: string; expiresAt: number; tokenUrl: string }
export interface FetchReport { received: number; created: number; updated: number }

export abstract class BaseSourceClientProvider {
  abstract readonly name: string;
  /** Refresh an expiring token; discovers the token endpoint once when the source has none. */
  abstract refresh(source: ConnectedSource, nowSeconds: number): Promise<RefreshedTokens>;
  /** Fetch every page of one resource type for the source's patient, writing through the door. */
  abstract fetch(source: ConnectedSource, resourceType: string, accessToken: string, writer: RecordsWriter, maxPages: number): Promise<FetchReport>;
}

/** The inert default: nothing is fetched, and a sync says so rather than pretending. */
export class NullSourceClientProvider extends BaseSourceClientProvider {
  readonly name = 'null';
  async refresh(): Promise<RefreshedTokens> { throw new Error('no source client is configured (sources.client.provider = null): tokens cannot be refreshed'); }
  async fetch(): Promise<FetchReport> { throw new Error('no source client is configured (sources.client.provider = null): nothing can be synced'); }
}
