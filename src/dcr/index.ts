/**
 * Dynamic Client Registration, RFC 7591 (yourphr#581; Phase 4 of yourphr#542; supersedes the Go
 * yourphr#355 on the transition path).
 *
 * Why this exists — the lesson of 2026-08-19: Epic issues refresh tokens to PUBLIC standalone
 * clients only through DCR (register a per-installation client, then use the refresh grant as
 * that client). The product went confidential to ship; DCR is the standards path that lets a
 * self-hosted install keep offline access WITHOUT a shared secret.
 *
 * Security posture — the registration endpoint is attacker-influenceable in exactly the way the
 * token endpoint is (it comes out of a document the PROVIDER controls), so it passes the same
 * gauntlet: SSRF-validated, https-only against an https base, no downgrade
 * (validateDiscoveredEndpoint), fetched through the guarded capability.
 *
 * Two response refusals with teeth:
 *   - no client_id -> not a registration, refuse.
 *   - redirect_uris in the response that we DID NOT REQUEST -> refuse outright. A server that
 *     "helpfully" adds a redirect URI has minted a way to steal authorization codes; accepting the
 *     rest of the registration would wire that theft in.
 */
import { OutboundHttp } from '../http/index.js';
import { validateDiscoveredEndpoint } from '../smart/index.js';
import type Database from 'better-sqlite3-multiple-ciphers';

export interface DcrRequest {
  registrationEndpoint: string;
  /** The https FHIR base the endpoint was discovered from — drives the no-downgrade rule. */
  baseIsHttps: boolean;
  clientName: string;
  redirectUris: string[];
  /** Epic-style: the access token from the FIRST authorization authorizes the registration. */
  initialAccessToken?: string;
  /** Tests only. */
  allowInternal?: boolean;
}

export interface DynamicClient {
  clientId: string;
  clientSecret: string;
  registrationAccessToken: string;
  registrationClientUri: string;
}

export async function registerDynamicClient(request: DcrRequest): Promise<DynamicClient> {
  // Same gauntlet as the token endpoint — see the module header.
  const endpoint = validateDiscoveredEndpoint(
    'registration_endpoint', request.registrationEndpoint, request.baseIsHttps, request.allowInternal ?? false
  );

  const http = new OutboundHttp({ allowInternal: request.allowInternal });
  const response = await http.get(endpoint.href, {
    method: 'POST',
    json: {
      client_name: request.clientName,
      redirect_uris: request.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    headers: request.initialAccessToken ? { authorization: `Bearer ${request.initialAccessToken}` } : {},
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`registration endpoint HTTP ${response.status}: ${response.body.toString('utf8').slice(0, 256)}`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`decoding the registration response: ${(err as Error).message}`);
  }

  const clientId = payload['client_id'];
  if (typeof clientId !== 'string' || clientId === '') {
    throw new Error('registration response carried no client_id — not a registration');
  }

  const echoed = payload['redirect_uris'];
  if (Array.isArray(echoed)) {
    const requested = new Set(request.redirectUris);
    const extras = echoed.filter((u) => typeof u !== 'string' || !requested.has(u));
    if (extras.length > 0) {
      throw new Error(
        `registration response added redirect_uris we never requested (${JSON.stringify(extras)}) — a code-steal vector; refusing the registration`
      );
    }
  }

  return {
    clientId,
    clientSecret: typeof payload['client_secret'] === 'string' ? payload['client_secret'] : '',
    registrationAccessToken: typeof payload['registration_access_token'] === 'string' ? payload['registration_access_token'] : '',
    registrationClientUri: typeof payload['registration_client_uri'] === 'string' ? payload['registration_client_uri'] : '',
  };
}

/** Persisted per-source dynamic credentials — the per-installation client DCR exists to mint. */
export class DynamicClientStore {
  constructor(private readonly db: InstanceType<typeof Database>) {
    db.exec(`CREATE TABLE IF NOT EXISTS dynamic_clients (
      source_id INTEGER PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL DEFAULT '',
      registration_access_token TEXT NOT NULL DEFAULT '',
      registration_client_uri TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL
    )`);
  }

  save(sourceId: number, client: DynamicClient): void {
    this.db
      .prepare(
        `INSERT INTO dynamic_clients (source_id, client_id, client_secret, registration_access_token, registration_client_uri, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id) DO UPDATE SET client_id=excluded.client_id, client_secret=excluded.client_secret,
           registration_access_token=excluded.registration_access_token, registration_client_uri=excluded.registration_client_uri,
           registered_at=excluded.registered_at`
      )
      .run(sourceId, client.clientId, client.clientSecret, client.registrationAccessToken, client.registrationClientUri, new Date().toISOString());
  }

  forSource(sourceId: number): DynamicClient | undefined {
    const row = this.db.prepare('SELECT * FROM dynamic_clients WHERE source_id = ?').get(sourceId) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      clientId: row['client_id'] ?? '',
      clientSecret: row['client_secret'] ?? '',
      registrationAccessToken: row['registration_access_token'] ?? '',
      registrationClientUri: row['registration_client_uri'] ?? '',
    };
  }
}
