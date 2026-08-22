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
import {createReadStream, existsSync, statSync} from 'node:fs';
import {extname, join, resolve, sep} from 'node:path';
import type {Resource, ResourceType} from '@medplum/fhirtypes';
import {SqliteFhirRepository} from './SqliteFhirRepository.js';
import type {AuthStore} from './auth/index.js';

/**
 * The Go cookie name, on purpose: a browser that moves between the two stacks during the cut-over
 * (yourphr#588) keeps one session entry, and the Angular app (yourphr#118 Phase 2b) never sees a
 * token — it relies entirely on this HttpOnly cookie being set on sign-in and read on /api/secure/*.
 */
export const SESSION_COOKIE = 'fasten_session';

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

export interface ServerAuth {
  store: AuthStore;
  /** Lifetime of the session cookie — the session's absolute cap; default 12h like DefaultSessionPolicy. */
  cookieMaxAgeSeconds?: number;
  /** Mark the cookie Secure. False behind a TLS-terminating proxy that talks plain HTTP to us (Go's web.listen.https.enabled posture). */
  secureCookies?: boolean;
  /**
   * The repository serving a VERIFIED user's requests. This signature is the point of the wiring
   * (yourphr#541): the user id stops being server configuration and becomes something each request
   * proves with a session — the isolation #537 demonstrated, enforced on the wire.
   */
  repoForUser: (username: string) => SqliteFhirRepository;
}

export interface ServerModules {
  /** GET /api/secure/summary/ips — the IPS document for the caller (yourphr#577). */
  ips?: (repo: SqliteFhirRepository) => Promise<unknown>;
  /** GET /api/secure/resource/provenance/:type/:id (yourphr#579). */
  provenanceFor?: (repo: SqliteFhirRepository, resourceType: string, id: string) => unknown;
  /** GET /api/secure/medications/reconciled (yourphr#580). */
  medications?: (repo: SqliteFhirRepository) => Promise<unknown>;
  /** Admin surface (yourphr#582): gate decides who counts as the operator. */
  /** What an anonymous caller may know about this instance (GET /api/instance/public). */
  publicInstance?: () => Record<string, unknown>;
  /** What a signed-in member may know (GET /api/secure/instance, yourphr#593): public plus the operator contact. */
  instanceForUser?: (username: string) => Record<string, unknown>;
  /** GET /api/secure/jobs (yourphr#593): the caller's sync jobs in Go's BackgroundJob shape. */
  jobsForUser?: (username: string, query: { limit: number; page: number; status?: string; jobType?: string }) => unknown[];
  admin?: {
    isAdmin: (username: string) => boolean;
    configSnapshot: () => unknown;
    catalogList: () => unknown;
    backupNow: () => unknown;
    createUser: (username: string, password: string) => void;
  };
}

export interface ServerOptions {
  /** The pinned single-user repository — used only when `auth` is absent (the read-only harnesses). */
  repo: SqliteFhirRepository;
  /** Which source every record is attributed to. See the note on sourceId below. */
  sourceId?: string;
  /**
   * When present, /api/secure/* requires a Bearer session from POST /api/auth/signin, and each
   * request is served as its verified user. Absent keeps the legacy pinned-user behavior for the
   * existing contract harnesses, which test reads, not auth.
   */
  auth?: ServerAuth;
  /** The assembled modules (yourphr#582). Absent keeps the bare read server. */
  modules?: ServerModules;
  /**
   * Directory holding the BUILT Angular app (yourphr#585). When set, non-/api requests serve
   * static files with an SPA fallback to index.html — one container replaces one container at
   * cut-over. API routes always win.
   */
  webDir?: string;
  /** Reported by GET /api/version — the Angular footer shows it. */
  version?: string;
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
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serves the built Angular app (yourphr#585). The one security rule that matters: the resolved
 * path must stay INSIDE webDir — a traversal (%2e%2e, ../) gets 404, not the file. SPA fallback:
 * an extensionless path is an Angular route and gets index.html; a missing asset (has an
 * extension) is an honest 404, because serving index.html as main.js breaks the app confusingly.
 */
function serveStatic(webDir: string, pathname: string, res: ServerResponse): void {
  const root = resolve(webDir);
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({success: false, error: 'not found'}));
    return;
  }

  let file = candidate;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(decoded) !== '') {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({success: false, error: 'not found'}));
      return;
    }
    file = join(root, 'index.html'); // the SPA fallback — Angular owns the route
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // index.html must revalidate (it names the hashed bundles); hashed assets may cache hard.
    'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}

/** Reads a small JSON body; refuses anything over 64KB — sign-in bodies have no reason to be big. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

export function createYourPhrServer(options: ServerOptions) {
  const sourceId = options.sourceId ?? 'spike';
  const auth = options.auth;

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      // GET /healthz — liveness/readiness for the orchestrator (yourphr#587). No session, no data:
      // it says the process is up and serving, nothing about who is asking.
      if (url.pathname === '/healthz' && req.method === 'GET') {
        send(res, 200, {ok: true});
        return;
      }

      // The Angular app's boot calls (found by the parity audit, yourphr#591) — Go's shapes exactly.
      if (url.pathname === '/api/version' && req.method === 'GET') {
        send(res, 200, {success: true, data: {version: options.version ?? '0.0.0-dev', environment_name: ''}});
        return;
      }
      if (url.pathname === '/api/health' && req.method === 'GET') {
        send(res, 200, {success: true, data: {first_run_wizard: false, standby_mode: false}});
        return;
      }
      if (url.pathname === '/api/instance/public' && req.method === 'GET') {
        send(res, 200, {success: true, data: options.modules?.publicInstance?.() ?? {}});
        return;
      }
      // Logout clears the HttpOnly cookie — the one thing JavaScript cannot do itself.
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        res.setHeader('Set-Cookie', sessionCookie('', 0, auth?.secureCookies ?? false));
        send(res, 200, {success: true});
        return;
      }

      // POST /api/auth/signin — the only route that exists without a session. Throttling, the
      // generic error and the trusted-proxy rule all live in AuthStore; this is just transport.
      if (auth && url.pathname === '/api/auth/signin' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const username = typeof body?.['username'] === 'string' ? (body['username'] as string) : '';
        const password = typeof body?.['password'] === 'string' ? (body['password'] as string) : '';
        const result = auth.store.signIn(username, password, {
          remoteAddr: req.socket.remoteAddress ?? '',
          xff: typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
        });
        if (!result.ok) {
          send(res, 401, {success: false, error: result.error});
          return;
        }
        // The Go envelope, exactly: data IS the token string — the Angular auth service does
        // setAuthToken(resp.data). Wrapping it in an object signed the user straight back out
        // (found by the parity audit, yourphr#591).
        res.setHeader('Set-Cookie', sessionCookie(result.token, auth.cookieMaxAgeSeconds ?? 12 * 60 * 60, auth.secureCookies ?? false));
        send(res, 200, {success: true, data: result.token});
        return;
      }

      // The session gate: with auth wired, every /api/secure/* request proves who it is, and is
      // served by THAT user's repository. 401 for no token, a tampered token, an expired one, or a
      // token whose generation the account has moved past (a password change ends it mid-flight).
      let repo = options.repo;
      let sessionUser = '';
      if (auth && url.pathname.startsWith('/api/secure/')) {
        // Bearer first (API clients, the harnesses), else the HttpOnly cookie (the browser).
        const header = req.headers['authorization'] ?? '';
        const bearer = typeof header === 'string' && header.toLowerCase().startsWith('bearer ') ? header.slice(7) : '';
        const token = bearer !== '' ? bearer : readCookie(req.headers['cookie'], SESSION_COOKIE);
        const session = token ? auth.store.verifySession(token) : ({ok: false} as const);
        if (!session.ok) {
          send(res, 401, {success: false, error: 'unauthorized'});
          return;
        }
        if (session.renewed) {
          res.setHeader('X-Renewed-Token', session.renewed);
          res.setHeader('Set-Cookie', sessionCookie(session.renewed, auth.cookieMaxAgeSeconds ?? 12 * 60 * 60, auth.secureCookies ?? false));
        }
        repo = auth.repoForUser(session.username);
        sessionUser = session.username;
      }

      // Who am I — the call the Angular app makes on every route to decide it is signed in, and
      // where it learns the role. Fields the spike does not store (full_name, email, picture) are
      // empty, not invented; id is the username because that is the spike's account identity.
      if (auth && url.pathname === '/api/secure/account/me' && req.method === 'GET') {
        send(res, 200, {success: true, data: {
          id: sessionUser, username: sessionUser, full_name: '', email: '', picture: '',
          role: options.modules?.admin?.isAdmin(sessionUser) ? 'admin' : 'user',
          demo_account: false, last_login: null, login_count: 0,
        }});
        return;
      }

      // --- the assembled modules (yourphr#582) ---
      const modules = options.modules;
      // The two calls every page makes (yourphr#593): who runs this instance, and the job indicator.
      if (modules?.instanceForUser && url.pathname === '/api/secure/instance' && req.method === 'GET') {
        send(res, 200, {success: true, data: modules.instanceForUser(sessionUser)});
        return;
      }
      if (modules?.jobsForUser && url.pathname === '/api/secure/jobs' && req.method === 'GET') {
        const limitParam = Number(url.searchParams.get('limit') ?? 0);
        const pageParam = Number(url.searchParams.get('page') ?? 0);
        if (!Number.isInteger(limitParam) || limitParam < 0 || !Number.isInteger(pageParam) || pageParam < 0) {
          send(res, 400, {success: false, error: 'limit and page must be non-negative integers'});
          return;
        }
        const query = {
          limit: limitParam === 0 ? 20 : limitParam, // Go's ResourceListPageSize when unset or 0
          page: pageParam,
          status: url.searchParams.get('status') ?? undefined,
          jobType: url.searchParams.get('jobType') ?? undefined,
        };
        send(res, 200, {success: true, data: modules.jobsForUser(sessionUser, query)});
        return;
      }
      if (modules?.ips && url.pathname === '/api/secure/summary/ips' && req.method === 'GET') {
        send(res, 200, {success: true, data: await modules.ips(repo)});
        return;
      }
      const provMatch = url.pathname.match(/^\/api\/secure\/resource\/provenance\/([^/]+)\/([^/]+)$/);
      if (modules?.provenanceFor && provMatch && req.method === 'GET') {
        const p = modules.provenanceFor(repo, provMatch[1]!, provMatch[2]!);
        if (!p) {
          send(res, 404, {success: false, error: 'not found'});
          return;
        }
        send(res, 200, {success: true, data: p});
        return;
      }
      if (modules?.medications && url.pathname === '/api/secure/medications/reconciled' && req.method === 'GET') {
        send(res, 200, {success: true, data: await modules.medications(repo)});
        return;
      }
      if (modules?.admin && url.pathname.startsWith('/api/secure/admin/')) {
        // Operator-only. The gate is a role check, not a route secret: a non-admin gets 403 with
        // no detail about what lives here.
        if (!modules.admin.isAdmin(sessionUser)) {
          send(res, 403, {success: false, error: 'admin role required'});
          return;
        }
        if (url.pathname === '/api/secure/admin/config' && req.method === 'GET') {
          send(res, 200, {success: true, data: modules.admin.configSnapshot()});
          return;
        }
        if (url.pathname === '/api/secure/admin/catalog' && req.method === 'GET') {
          send(res, 200, {success: true, data: modules.admin.catalogList()});
          return;
        }
        if (url.pathname === '/api/secure/admin/backup' && req.method === 'POST') {
          send(res, 200, {success: true, data: modules.admin.backupNow()});
          return;
        }
        if (url.pathname === '/api/secure/admin/users' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const username = typeof body?.['username'] === 'string' ? (body['username'] as string) : '';
          const password = typeof body?.['password'] === 'string' ? (body['password'] as string) : '';
          try {
            modules.admin.createUser(username, password);
          } catch (err) {
            send(res, 400, {success: false, error: (err as Error).message});
            return;
          }
          send(res, 200, {success: true});
          return;
        }
      }

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

      if (options.webDir && !url.pathname.startsWith('/api/')) {
        serveStatic(options.webDir, url.pathname, res);
        return;
      }

      send(res, 404, {success: false, error: 'not found'});
    } catch (err) {
      // Errors reach the caller rather than vanishing — the lesson of the product repo's #527.
      send(res, 500, {success: false, error: (err as Error).message});
    }
  });
}
