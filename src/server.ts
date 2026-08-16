/**
 * The HTTP layer, serving YOURPHR's API contract rather than FHIR REST (#537).
 *
 * The evaluation assumes a backend rewrite does not force a frontend rewrite, because "the Angular
 * app talks to an HTTP contract a TypeScript backend can serve unchanged". This is the test of that
 * assumption, and it is not free: **the frontend does not speak FHIR REST.**
 *
 * Medplum's FhirRouter serves `GET /Condition?patient=x` returning a Bundle. The Angular app calls
 * `GET /api/secure/resource/fhir?sourceResourceType=Condition` and expects
 * `{success, data: ResourceFhir[]}`, where ResourceFhir WRAPS the FHIR resource with YourPHR's own
 * metadata:
 *
 *     { source_id, source_resource_type, source_resource_id, fhir_version,
 *       resource_raw, sort_title, sort_date, provenance?, classified? }
 *
 * So keeping the frontend means writing an adapter, and the adapter needs data a FHIR-native store
 * does not hold. That is the finding; the cost is real but bounded, and it is far smaller than
 * rewriting 76.8k lines of Angular.
 */
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import {SqliteFhirRepository} from './SqliteFhirRepository.js';

export interface ServerOptions {
  repo: SqliteFhirRepository;
  /** Which source every record is attributed to. See the note on sourceId below. */
  sourceId?: string;
}

/**
 * Wrap a FHIR resource the way the Angular app expects to receive it.
 *
 * THREE FIELDS THE SPIKE CANNOT PRODUCE, and they are the honest cost of this layer:
 *
 *   source_id   — which connected provider a record came from. YourPHR stores it per record; a
 *                 FHIR-native store has no such concept. Migrating means persisting it alongside.
 *   sort_title  — a display title the Go backend derives per resource type at write time. The list
 *                 views sort and label by it, so an empty one gives a screen of blank rows.
 *   provenance / classified — attached on the read path (#271, #308/#309), not stored.
 *
 * None is hard; all are invisible until the screen renders wrong, which is exactly why this had to
 * be built rather than reasoned about.
 */
export function toResourceFhir(resource: Resource, sourceId: string): Record<string, unknown> {
  return {
    source_id: sourceId,
    source_resource_type: resource.resourceType,
    source_resource_id: resource.id,
    fhir_version: 'R4',
    resource_raw: resource,
    // Best effort from the resource itself. The Go side computes a richer title per type; matching
    // it exactly is adapter work, not a question about whether the approach can work.
    sort_title: titleFor(resource),
    sort_date: dateFor(resource),
  };
}

function titleFor(resource: any): string {
  return (
    resource.code?.text ||
    resource.code?.coding?.[0]?.display ||
    resource.type?.[0]?.text ||
    resource.type?.coding?.[0]?.display ||
    resource.description ||
    resource.name?.[0]?.text ||
    resource.name ||
    ''
  );
}

function dateFor(resource: any): string | null {
  return (
    resource.effectiveDateTime ||
    resource.onsetDateTime ||
    resource.recordedDate ||
    resource.date ||
    resource.created ||
    resource.period?.start ||
    resource.meta?.lastUpdated ||
    null
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded)});
  res.end(encoded);
}

/**
 * Serves the subset of YourPHR's API the record screens actually use. Read-only, and deliberately
 * so: this exists to answer "can the existing frontend load records from the TypeScript stack",
 * not to be a backend.
 */
export function createYourPhrServer(options: ServerOptions) {
  const {repo} = options;
  const sourceId = options.sourceId ?? 'spike';

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // GET /api/secure/resource/fhir?sourceResourceType=Condition
      if (url.pathname === '/api/secure/resource/fhir' && req.method === 'GET') {
        const resourceType = url.searchParams.get('sourceResourceType');
        if (!resourceType) {
          send(res, 400, {success: false, error: 'sourceResourceType is required'});
          return;
        }
        const bundle = await repo.search({
          resourceType: resourceType as ResourceType,
          count: Number(url.searchParams.get('limit') ?? 100000),
          total: 'accurate',
        });
        send(res, 200, {
          success: true,
          data: (bundle.entry ?? []).map((entry) => toResourceFhir(entry.resource as Resource, sourceId)),
        });
        return;
      }

      // GET /api/secure/resource/fhir/:sourceId/:resourceId — the detail page
      const detail = url.pathname.match(/^\/api\/secure\/resource\/fhir\/([^/]+)\/([^/]+)$/);
      if (detail && req.method === 'GET') {
        const resourceId = detail[2]!;
        // YourPHR addresses a record by (source, id) without naming the type, so the type has to be
        // found. A FHIR-native store addresses by (type, id) — another seam the adapter absorbs.
        const row = repo.db
          .prepare('SELECT resource_type, content FROM resources WHERE id = ? AND user_id = ? AND deleted = 0')
          .get(resourceId, repo.userId ?? '') as {resource_type: string; content: string} | undefined;
        if (!row) {
          send(res, 404, {success: false, error: 'not found'});
          return;
        }
        send(res, 200, {success: true, data: toResourceFhir(JSON.parse(row.content), sourceId)});
        return;
      }

      // GET /api/secure/summary — what the dashboard counts from
      if (url.pathname === '/api/secure/summary' && req.method === 'GET') {
        const rows = repo.db
          .prepare(
            'SELECT resource_type, COUNT(*) AS count FROM resources WHERE deleted = 0 AND user_id = ? GROUP BY resource_type'
          )
          .all(repo.userId ?? '') as {resource_type: string; count: number}[];
        send(res, 200, {
          success: true,
          data: {
            resource_type_counts: rows,
            sources: [{id: sourceId, display: 'spike'}],
            patients: [],
          },
        });
        return;
      }

      send(res, 404, {success: false, error: 'not found'});
    } catch (err) {
      // Errors reach the caller rather than vanishing — the lesson of the product repo's #527.
      send(res, 500, {success: false, error: (err as Error).message});
    }
  });
}
